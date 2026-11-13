import { createHash } from "node:crypto";
import { App } from "aws-cdk-lib";
import { MarginStack } from "../lib/margin-stack.ts";
import { CiStack } from "../lib/ci-stack.ts";

const app = new App();
const ctx = (k: string) => {
  const v = app.node.tryGetContext(k);
  return typeof v === "string" ? v.trim() : v;
};
const flag = (k: string) => ctx(k) === true || ctx(k) === "true";

const env = { account: process.env.CDK_DEFAULT_ACCOUNT, region: process.env.CDK_DEFAULT_REGION };

new CiStack(app, "MarginCi", {
  env,
  githubRepo: ctx("githubRepo"),
  githubBranch: ctx("githubBranch") || "main",
  existingOidcProviderArn: ctx("githubOidcProviderArn") || undefined,
  githubOwnerId: ctx("githubOwnerId") ? String(ctx("githubOwnerId")) : undefined,
  githubRepoId: ctx("githubRepoId") ? String(ctx("githubRepoId")) : undefined,
});

// Domain mode when all three are set; otherwise CloudFront mode (free https://dxxxx.cloudfront.net URL).
const domainName = ctx("domainName");
const hostedZoneId = ctx("hostedZoneId");
const hostedZoneName = ctx("hostedZoneName");
const domain =
  domainName && hostedZoneId && hostedZoneName
    ? {
        domainName,
        hostedZoneId,
        hostedZoneName,
        authEnabled: ctx("authEnabled") !== false && ctx("authEnabled") !== "false",
        allowedCidrs: String(ctx("allowedCidrs") ?? "").split(",").map((s) => s.trim()).filter(Boolean),
      }
    : undefined;

// CloudFront mode password, "user:password". Read from the environment so it stays out of shell history
// and CI logs; only its hash goes into the CloudFormation template.
const basicAuth = process.env.MARGIN_BASIC_AUTH?.trim();
if (basicAuth && !/^[^:]+:.{8,}$/.test(basicAuth)) {
  throw new Error("MARGIN_BASIC_AUTH must look like user:password, with a password of at least 8 characters");
}
const basicAuthSha256 = basicAuth
  ? createHash("sha256").update(`Basic ${Buffer.from(basicAuth, "utf8").toString("base64")}`).digest("hex")
  : undefined;

const publicAccess = flag("publicAccess");
if (domain || basicAuthSha256 || publicAccess) {
  new MarginStack(app, "MarginApp", {
    env,
    engineScript: ctx("engineScript") || "engine:offline",
    domain,
    cloudfront: { basicAuthSha256, publicAccess, prefixListId: ctx("cloudfrontPrefixListId") || undefined },
  });
} else {
  // Never deploy an open engine by accident. (MarginCi still synthesizes, so `npm run deploy:ci` works.)
  console.warn("[margin-infra] MarginApp not defined: set MARGIN_BASIC_AUTH=user:password (or -c publicAccess=true, or a domain)");
}
