/**
 * Margin on AWS: one Fargate task (engine + dashboard) behind an Application Load Balancer.
 * Two ways in, chosen by whether a domain is configured:
 *
 * Domain mode (domain set):
 *   Route 53 ─► ALB :443 (ACM cert, Cognito login, idle timeout 300 s for SSE) ─► task
 *
 * CloudFront mode (no domain):
 *   https://dxxxx.cloudfront.net ─► CloudFront (HTTPS, Basic-auth password check in a CloudFront Function)
 *     ─► ALB :80, reachable only from CloudFront's address ranges AND only with a secret origin header ─► task
 *
 * In both:   /api/* ─► engine :4100      everything else ─► dashboard :3000
 *   EFS at /app/data   SQLite run ledgers + mandate credentials (the startup sweeper needs them after a crash)
 *   Secrets Manager    margin/app: one JSON object of env vars, expanded by deploy/entrypoint.mjs
 *
 * Exactly one task, ever: the engine holds its one DemoSession in memory and is the only SQLite writer.
 * Deployments stop the old task before starting the new one (minHealthyPercent 0, maxHealthyPercent 100).
 */
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { CfnOutput, Duration, RemovalPolicy, SecretValue, Stack, type StackProps } from "aws-cdk-lib";
import * as acm from "aws-cdk-lib/aws-certificatemanager";
import * as cloudfront from "aws-cdk-lib/aws-cloudfront";
import * as origins from "aws-cdk-lib/aws-cloudfront-origins";
import * as cognito from "aws-cdk-lib/aws-cognito";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import { Platform } from "aws-cdk-lib/aws-ecr-assets";
import * as ecs from "aws-cdk-lib/aws-ecs";
import * as efs from "aws-cdk-lib/aws-efs";
import * as elbv2 from "aws-cdk-lib/aws-elasticloadbalancingv2";
import * as elbActions from "aws-cdk-lib/aws-elasticloadbalancingv2-actions";
import * as logs from "aws-cdk-lib/aws-logs";
import * as route53 from "aws-cdk-lib/aws-route53";
import * as targets from "aws-cdk-lib/aws-route53-targets";
import * as secretsmanager from "aws-cdk-lib/aws-secretsmanager";
import type { Construct } from "constructs";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const ORIGIN_HEADER = "x-margin-origin-verify";

export interface DomainConfig {
  /** e.g. margin.example.com */
  domainName: string;
  hostedZoneId: string;
  /** e.g. example.com */
  hostedZoneName: string;
  /** Cognito login in front of everything. Turn off only together with allowedCidrs. */
  authEnabled: boolean;
  /** Restrict the ALB to these CIDRs. Empty: open to the internet (login still applies). */
  allowedCidrs: string[];
}

export interface CloudFrontConfig {
  /** Hex SHA-256 of the expected `Authorization` header ("Basic " + base64(user:password)). Never the password itself. */
  basicAuthSha256?: string;
  /** No password at all: anyone with the URL can use the dashboard and start runs. */
  publicAccess: boolean;
  /** Override for the CloudFront origin-facing managed prefix list (otherwise looked up). */
  prefixListId?: string;
}

export interface MarginStackProps extends StackProps {
  /** npm script the engine runs: engine:offline (safe default), engine:live, engine:live-full, ... */
  engineScript: string;
  /** Set: domain mode. Unset: CloudFront mode with `cloudfront`. */
  domain?: DomainConfig;
  cloudfront?: CloudFrontConfig;
}

export class MarginStack extends Stack {
  constructor(scope: Construct, id: string, props: MarginStackProps) {
    super(scope, id, props);
    const cf = props.cloudfront ?? { publicAccess: false };
    if (props.domain && !props.domain.authEnabled && props.domain.allowedCidrs.length === 0) {
      throw new Error("authEnabled=false needs allowedCidrs: the engine API has no auth of its own and can start paid runs");
    }
    if (!props.domain && !cf.publicAccess && !cf.basicAuthSha256) {
      throw new Error("CloudFront mode needs a password: set MARGIN_BASIC_AUTH=user:password (or publicAccess=true to go without)");
    }

    // --- Network -----------------------------------------------------------------------------
    const vpc = new ec2.Vpc(this, "Vpc", { maxAzs: 2, natGateways: 1 });
    const cluster = new ecs.Cluster(this, "Cluster", { vpc, containerInsightsV2: ecs.ContainerInsights.ENABLED });

    // --- Storage and secrets -----------------------------------------------------------------
    const fs = new efs.FileSystem(this, "Data", {
      vpc,
      encrypted: true,
      removalPolicy: RemovalPolicy.RETAIN,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
    });
    const accessPoint = fs.addAccessPoint("DataAp", {
      path: "/margin-data",
      posixUser: { uid: "1000", gid: "1000" }, // the image's `node` user
      createAcl: { ownerUid: "1000", ownerGid: "1000", permissions: "750" },
    });

    const secrets = new secretsmanager.Secret(this, "AppSecrets", {
      secretName: "margin/app",
      description: "Margin engine env vars as one JSON object (see docs/DEPLOY_AWS.md). Edit in the console; CDK never overwrites it.",
      secretStringValue: SecretValue.unsafePlainText("{}"),
      removalPolicy: RemovalPolicy.RETAIN,
    });

    // --- Task --------------------------------------------------------------------------------
    const task = new ecs.FargateTaskDefinition(this, "Task", {
      cpu: 1024,
      memoryLimitMiB: 2048,
      runtimePlatform: { cpuArchitecture: ecs.CpuArchitecture.X86_64, operatingSystemFamily: ecs.OperatingSystemFamily.LINUX },
      volumes: [
        {
          name: "data",
          efsVolumeConfiguration: {
            fileSystemId: fs.fileSystemId,
            transitEncryption: "ENABLED",
            authorizationConfig: { accessPointId: accessPoint.accessPointId, iam: "ENABLED" },
          },
        },
      ],
    });
    fs.grantReadWrite(task.taskRole);

    const logGroup = new logs.LogGroup(this, "Logs", { retention: logs.RetentionDays.THREE_MONTHS, removalPolicy: RemovalPolicy.DESTROY });

    const engine = task.addContainer("engine", {
      image: ecs.ContainerImage.fromAsset(REPO_ROOT, { file: "Dockerfile.engine", platform: Platform.LINUX_AMD64 }),
      essential: true,
      environment: { ENGINE_SCRIPT: props.engineScript, PORT: "4100" },
      secrets: { MARGIN_SECRETS_JSON: ecs.Secret.fromSecretsManager(secrets) },
      portMappings: [{ containerPort: 4100 }],
      logging: ecs.LogDrivers.awsLogs({ logGroup, streamPrefix: "engine" }),
      stopTimeout: Duration.seconds(60),
    });
    engine.addMountPoints({ sourceVolume: "data", containerPath: "/app/data", readOnly: false });

    task.addContainer("dashboard", {
      // Calls the engine at /api on its own origin, so the image doesn't depend on the URL.
      image: ecs.ContainerImage.fromAsset(join(REPO_ROOT, "apps", "dashboard"), {
        platform: Platform.LINUX_AMD64,
        buildArgs: { NEXT_PUBLIC_ENGINE_URL: "same-origin" },
      }),
      essential: true,
      portMappings: [{ containerPort: 3000 }],
      logging: ecs.LogDrivers.awsLogs({ logGroup, streamPrefix: "dashboard" }),
    });

    const service = new ecs.FargateService(this, "Service", {
      cluster,
      taskDefinition: task,
      desiredCount: 1,
      minHealthyPercent: 0,
      maxHealthyPercent: 100,
      circuitBreaker: { rollback: true },
      enableExecuteCommand: true,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      healthCheckGracePeriod: Duration.seconds(120),
    });
    fs.connections.allowDefaultPortFrom(service);

    // --- Load balancer -----------------------------------------------------------------------
    const albSg = new ec2.SecurityGroup(this, "AlbSg", { vpc, description: "Margin ALB", allowAllOutbound: false });
    const alb = new elbv2.ApplicationLoadBalancer(this, "Alb", {
      vpc,
      internetFacing: true,
      securityGroup: albSg,
      // SSE (/api/stream) pings every 15 s; this only has to be comfortably longer than that.
      idleTimeout: Duration.seconds(300),
      dropInvalidHeaderFields: true,
    });

    const engineTg = new elbv2.ApplicationTargetGroup(this, "EngineTg", {
      vpc,
      port: 4100,
      protocol: elbv2.ApplicationProtocol.HTTP,
      targets: [service.loadBalancerTarget({ containerName: "engine", containerPort: 4100 })],
      healthCheck: { path: "/api/meta", healthyHttpCodes: "200", interval: Duration.seconds(30) },
      deregistrationDelay: Duration.seconds(10),
    });
    const dashboardTg = new elbv2.ApplicationTargetGroup(this, "DashboardTg", {
      vpc,
      port: 3000,
      protocol: elbv2.ApplicationProtocol.HTTP,
      targets: [service.loadBalancerTarget({ containerName: "dashboard", containerPort: 3000 })],
      healthCheck: { path: "/", healthyHttpCodes: "200", interval: Duration.seconds(30) },
      deregistrationDelay: Duration.seconds(10),
    });

    const url = props.domain
      ? this.domainFrontDoor(props.domain, alb, albSg, engineTg, dashboardTg)
      : this.cloudFrontFrontDoor(cf, alb, albSg, engineTg, dashboardTg);

    new CfnOutput(this, "Url", { value: url });
    new CfnOutput(this, "SecretName", { value: secrets.secretName, description: "Put engine env vars here as JSON" });
    new CfnOutput(this, "ClusterName", { value: cluster.clusterName });
    new CfnOutput(this, "ServiceName", { value: service.serviceName });
    new CfnOutput(this, "LogGroup", { value: logGroup.logGroupName });
  }

  /** Route 53 + ACM + Cognito on the ALB itself. */
  private domainFrontDoor(
    d: DomainConfig,
    alb: elbv2.ApplicationLoadBalancer,
    albSg: ec2.SecurityGroup,
    engineTg: elbv2.ApplicationTargetGroup,
    dashboardTg: elbv2.ApplicationTargetGroup,
  ): string {
    const url = `https://${d.domainName}`;
    const zone = route53.HostedZone.fromHostedZoneAttributes(this, "Zone", { hostedZoneId: d.hostedZoneId, zoneName: d.hostedZoneName });
    const cert = new acm.Certificate(this, "Cert", { domainName: d.domainName, validation: acm.CertificateValidation.fromDns(zone) });

    const sources = d.allowedCidrs.length ? d.allowedCidrs.map((c) => ec2.Peer.ipv4(c)) : [ec2.Peer.anyIpv4(), ec2.Peer.anyIpv6()];
    for (const p of sources) {
      albSg.addIngressRule(p, ec2.Port.tcp(443), "HTTPS");
      albSg.addIngressRule(p, ec2.Port.tcp(80), "HTTP (redirects to HTTPS)");
    }

    let protect = (next: elbv2.ListenerAction) => next;
    if (d.authEnabled) {
      const userPool = new cognito.UserPool(this, "Users", {
        selfSignUpEnabled: false, // an admin creates every user
        signInAliases: { email: true },
        mfa: cognito.Mfa.OPTIONAL,
        mfaSecondFactor: { sms: false, otp: true },
        passwordPolicy: { minLength: 12 },
        removalPolicy: RemovalPolicy.RETAIN,
      });
      const userPoolDomain = userPool.addDomain("Domain", { cognitoDomain: { domainPrefix: `margin-${this.account}` } });
      const userPoolClient = userPool.addClient("AlbClient", {
        generateSecret: true,
        oAuth: {
          flows: { authorizationCodeGrant: true },
          scopes: [cognito.OAuthScope.OPENID, cognito.OAuthScope.EMAIL],
          callbackUrls: [`${url}/oauth2/idpresponse`],
          logoutUrls: [url],
        },
      });
      protect = (next) => new elbActions.AuthenticateCognitoAction({ userPool, userPoolClient, userPoolDomain, next });
      new CfnOutput(this, "UserPoolId", { value: userPool.userPoolId, description: "Create users here (Cognito console → Users → Create user)" });
    }

    const https = alb.addListener("Https", {
      port: 443,
      certificates: [cert],
      open: false,
      sslPolicy: elbv2.SslPolicy.RECOMMENDED_TLS,
      defaultAction: protect(elbv2.ListenerAction.forward([dashboardTg])),
    });
    https.addAction("Api", {
      priority: 10,
      conditions: [elbv2.ListenerCondition.pathPatterns(["/api/*"])],
      action: protect(elbv2.ListenerAction.forward([engineTg])),
    });
    alb.addListener("Http", {
      port: 80,
      open: false,
      defaultAction: elbv2.ListenerAction.redirect({ protocol: "HTTPS", port: "443", permanent: true }),
    });

    new route53.ARecord(this, "Alias", { zone, recordName: d.domainName, target: route53.RecordTarget.fromAlias(new targets.LoadBalancerTarget(alb)) });
    return url;
  }

  /** CloudFront (HTTPS + password) in front of an ALB that only answers CloudFront. */
  private cloudFrontFrontDoor(
    cf: CloudFrontConfig,
    alb: elbv2.ApplicationLoadBalancer,
    albSg: ec2.SecurityGroup,
    engineTg: elbv2.ApplicationTargetGroup,
    dashboardTg: elbv2.ApplicationTargetGroup,
  ): string {
    // Lock 1: the ALB's firewall only admits CloudFront's origin-facing address ranges.
    const prefixListId =
      cf.prefixListId ?? ec2.PrefixList.fromLookup(this, "CloudFrontOriginFacing", { prefixListName: "com.amazonaws.global.cloudfront.origin-facing" }).prefixListId;
    albSg.addIngressRule(ec2.Peer.prefixList(prefixListId), ec2.Port.tcp(80), "CloudFront origin-facing only");

    // Lock 2: CloudFront adds a secret header, and the ALB forwards only requests carrying it,
    // so another CloudFront distribution pointed at this ALB gets nothing.
    const originSecret = new secretsmanager.Secret(this, "OriginVerify", {
      description: "Header value CloudFront sends to the Margin ALB",
      generateSecretString: { excludePunctuation: true, passwordLength: 48 },
    });
    const originSecretValue = originSecret.secretValue.unsafeUnwrap();

    const http = alb.addListener("Http", {
      port: 80,
      open: false,
      defaultAction: elbv2.ListenerAction.fixedResponse(403, { contentType: "text/plain", messageBody: "Forbidden" }),
    });
    http.addAction("Api", {
      priority: 10,
      conditions: [elbv2.ListenerCondition.httpHeader(ORIGIN_HEADER, [originSecretValue]), elbv2.ListenerCondition.pathPatterns(["/api/*"])],
      action: elbv2.ListenerAction.forward([engineTg]),
    });
    http.addAction("Dashboard", {
      priority: 20,
      conditions: [elbv2.ListenerCondition.httpHeader(ORIGIN_HEADER, [originSecretValue])],
      action: elbv2.ListenerAction.forward([dashboardTg]),
    });

    // The front door: a browser password prompt checked at the edge, before anything reaches AWS's network.
    const functionAssociations: cloudfront.FunctionAssociation[] = [];
    if (!cf.publicAccess) {
      const fn = new cloudfront.Function(this, "BasicAuth", {
        runtime: cloudfront.FunctionRuntime.JS_2_0,
        comment: "Margin: Basic-auth password check",
        code: cloudfront.FunctionCode.fromInline(basicAuthFunction(cf.basicAuthSha256!)),
      });
      functionAssociations.push({ function: fn, eventType: cloudfront.FunctionEventType.VIEWER_REQUEST });
    }

    const origin = new origins.HttpOrigin(alb.loadBalancerDnsName, {
      protocolPolicy: cloudfront.OriginProtocolPolicy.HTTP_ONLY,
      customHeaders: { [ORIGIN_HEADER]: originSecretValue },
      // Time allowed between bytes from the origin; SSE sends a ping every 15 s.
      readTimeout: Duration.seconds(60),
      keepaliveTimeout: Duration.seconds(60),
    });
    const dynamic: cloudfront.BehaviorOptions = {
      origin,
      viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
      allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
      cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
      originRequestPolicy: cloudfront.OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
      compress: false, // keep the SSE stream unbuffered
      functionAssociations,
    };
    const distribution = new cloudfront.Distribution(this, "Cdn", {
      comment: "Margin dashboard and engine",
      defaultBehavior: dynamic,
      additionalBehaviors: {
        // Next.js build output is content-hashed: safe to cache. The password check still runs first.
        "/_next/static/*": {
          origin,
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
          cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
          functionAssociations,
        },
      },
      httpVersion: cloudfront.HttpVersion.HTTP2_AND_3,
    });

    new CfnOutput(this, "DistributionId", { value: distribution.distributionId });
    new CfnOutput(this, "Access", { value: cf.publicAccess ? "PUBLIC: no password" : "Basic auth: the username and password in MARGIN_BASIC_AUTH" });
    return `https://${distribution.distributionDomainName}`;
  }
}

/** CloudFront Function (cloudfront-js-2.0). Holds only a hash, so the password never appears in the template. */
function basicAuthFunction(expectedSha256: string): string {
  if (!/^[0-9a-f]{64}$/.test(expectedSha256)) throw new Error("basicAuthSha256 must be a hex SHA-256");
  return `
const crypto = require('crypto');
const EXPECTED = '${expectedSha256}';
function handler(event) {
  var h = event.request.headers.authorization;
  if (h && crypto.createHash('sha256').update(h.value).digest('hex') === EXPECTED) {
    return event.request;
  }
  return {
    statusCode: 401,
    statusDescription: 'Unauthorized',
    headers: { 'www-authenticate': { value: 'Basic realm="Margin", charset="UTF-8"' } }
  };
}
`;
}
