// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0
import * as cdk from 'aws-cdk-lib';
import { AwsSolutionsChecks } from 'cdk-nag';
import { ImageIntegrityStack } from '../lib/integrity-pipeline-stack';

const app = new cdk.App();

const stackName: string = app.node.tryGetContext('stackName') ?? 'image-integrity';

new ImageIntegrityStack(app, stackName, {
  description:
    'Multi-signal image integrity pipeline (sample code, not for production use without further review)',
});

// cdk-nag fails synthesis on AWS Solutions rule violations: public buckets,
// open security groups, missing encryption, wildcard IAM, and more. Suppress a
// rule only with a written justification through NagSuppressions.
cdk.Aspects.of(app).add(new AwsSolutionsChecks({ verbose: true }));
