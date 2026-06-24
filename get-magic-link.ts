#!/usr/bin/env node
// Pull the latest verification token for rick@rbcodelabs.com from Aurora DSQL

import { Pool } from "pg";
import { DsqlSigner } from "@aws-sdk/dsql-signer";
import { awsCredentialsProvider } from "@vercel/functions/oidc";

const HOST = "bft32oacdzjni3wk5eetybc6aq.dsql.us-east-1.on.aws";
const REGION = "us-east-1";

const signer = new DsqlSigner({
  credentials: awsCredentialsProvider({
    roleArn: process.env.AWS_ROLE_ARN!,
    clientConfig: { region: REGION },
  }),
  hostname: HOST,
  region: REGION,
  expiresIn: 900,
});

const pool = new Pool({
  host: HOST,
  user: "admin",
  database: "postgres",
  password: () => signer.getDbConnectAdminAuthToken(),
  port: 5432,
  ssl: true,
  max: 1,
});

const client = await pool.connect();

// Check both schemas — preview and main
for (const schema of ["compass_preview", "compass"]) {
  try {
    const { rows } = await client.query(
      `SELECT identifier, token, expires
       FROM "${schema}".verification_tokens
       WHERE identifier = $1
       ORDER BY expires DESC
       LIMIT 1`,
      ["rick@rbcodelabs.com"]
    );

    if (rows.length > 0) {
      const { token, expires } = rows[0];
      // NextAuth callback URL format
      const callbackUrl = `https://compass-git-feat-compass-mvp-rbcodelabs-team.vercel.app/api/auth/callback/resend?callbackUrl=%2Fdashboard&token=${encodeURIComponent(token)}&email=${encodeURIComponent("rick@rbcodelabs.com")}`;
      console.log(`Schema: ${schema}`);
      console.log(`Token: ${token}`);
      console.log(`Expires: ${expires}`);
      console.log(`\nCallback URL:\n${callbackUrl}`);
      break;
    } else {
      console.log(`No token in schema ${schema}`);
    }
  } catch (e) {
    console.log(`Schema ${schema} error: ${e instanceof Error ? e.message : e}`);
  }
}

client.release();
await pool.end();
