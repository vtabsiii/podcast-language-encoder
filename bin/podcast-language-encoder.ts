#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { PodcastLanguageEncoderStack } from '../lib/podcast-language-encoder-stack';
import { GithubOidcStack } from '../lib/github-oidc-stack';

const app = new cdk.App();

// Account/region come from the credentials in use (CLI, CloudShell, or GitHub Actions).
// Override with CDK_DEFAULT_ACCOUNT / CDK_DEFAULT_REGION or the AWS_* env vars.
const env: cdk.Environment = {
  account: process.env.CDK_DEFAULT_ACCOUNT,
  region: process.env.CDK_DEFAULT_REGION,
};

const githubOwner = app.node.tryGetContext('githubOwner') ?? 'vtabsiii';
const githubRepo = app.node.tryGetContext('githubRepo') ?? 'podcast-language-encoder';
const targetLanguages: string = app.node.tryGetContext('targetLanguages') ?? 'es,fr,de,pt';

// One-time stack: lets GitHub Actions in this repo deploy without long-lived AWS keys.
new GithubOidcStack(app, 'PodcastLanguageEncoderGithubOidc', {
  env,
  githubOwner,
  githubRepo,
  description: 'GitHub Actions OIDC provider + deploy role for podcast-language-encoder',
});

// The application itself.
new PodcastLanguageEncoderStack(app, 'PodcastLanguageEncoder', {
  env,
  targetLanguages: targetLanguages.split(',').map((s) => s.trim()).filter(Boolean),
  description: 'Podcast language encoder: transcribe -> translate -> re-voice pipeline',
});

cdk.Tags.of(app).add('project', 'podcast-language-encoder');
