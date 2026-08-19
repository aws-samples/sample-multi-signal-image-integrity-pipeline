// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0
import * as cdk from 'aws-cdk-lib';
import * as apigwv2 from 'aws-cdk-lib/aws-apigatewayv2';
import * as authorizers from 'aws-cdk-lib/aws-apigatewayv2-authorizers';
import * as integrations from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as s3deploy from 'aws-cdk-lib/aws-s3-deployment';
import * as sfn from 'aws-cdk-lib/aws-stepfunctions';
import * as tasks from 'aws-cdk-lib/aws-stepfunctions-tasks';
import { NagSuppressions } from 'cdk-nag';
import { Construct } from 'constructs';

/**
 * Multi-signal image integrity pipeline.
 *
 * An image in Amazon S3 is scored by five signals on AWS Step Functions: four
 * run in parallel (Amazon Bedrock semantic analysis, Error Level Analysis,
 * frequency analysis, EXIF metadata), then a cross-evidence signal re-reads the
 * photo alongside the generated artefacts. An aggregator writes a weighted
 * verdict to Amazon DynamoDB. A Cloudscape review UI on Amazon S3 and Amazon
 * CloudFront reads results through an authenticated Amazon API Gateway HTTP API.
 */
export class ImageIntegrityStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // Inference profile for the multimodal signals. Cross-region profile
    // prefixes (us., eu., apac., au.) keep inference inside that geography.
    // Override with -c bedrockModelId=...
    const bedrockModelId: string =
      this.node.tryGetContext('bedrockModelId') ?? 'anthropic.claude-sonnet-4-5-20250929-v1:0';

    // --- Access-log destination for the other buckets -----------------------
    // Access logs expire on a schedule rather than accumulating for the life of
    // the stack. Ninety days is a starting point, not a measured one: raise it to
    // whatever your own log-retention standard requires before you rely on these
    // logs to reconstruct who read an image.
    const logBucket = new s3.Bucket(this, 'LogBucket', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      objectOwnership: s3.ObjectOwnership.BUCKET_OWNER_PREFERRED,
      lifecycleRules: [
        { id: 'ExpireAccessLogs', enabled: true, expiration: cdk.Duration.days(90) },
      ],
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });
    NagSuppressions.addResourceSuppressions(logBucket, [
      {
        id: 'AwsSolutions-S1',
        reason:
          'This bucket is the access-log destination for the image and site buckets. Amazon S3 advises against pointing a bucket at itself for access logs, because every log delivery then generates further log records.',
      },
    ]);

    // --- Results table -----------------------------------------------------
    const table = new dynamodb.Table(this, 'ResultsTable', {
      partitionKey: { name: 'pk', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'sk', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      encryption: dynamodb.TableEncryption.AWS_MANAGED,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: false },
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });
    NagSuppressions.addResourceSuppressions(table, [
      {
        id: 'AwsSolutions-DDB3',
        reason:
          'Analysis verdicts are derived data that can be recomputed by re-running the pipeline. Enable point-in-time recovery if you retain verdicts as a system of record.',
      },
    ]);

    // --- Image bucket (inputs plus generated forensic artefacts) ------------
    // The name is set explicitly so that `imageBucketName` below is a plain
    // string rather than a CloudFormation reference to this bucket. That lets the
    // CORS rule at the bottom of this file point at the CloudFront domain without
    // creating a dependency cycle: the functions that read the bucket name would
    // otherwise make the distribution transitively depend on this bucket, while
    // the CORS rule makes this bucket depend on the distribution.
    // Fn.join keeps the whole value a single token, which CDK accepts as a bucket
    // name; a partly-interpolated string fails validation. The account and region
    // are CloudFormation pseudo-parameters, so they add no resource dependency.
    const imageBucketName = cdk.Fn.join('-', [
      cdk.Names.uniqueResourceName(this, { maxLength: 24 }).toLowerCase(),
      'images',
      this.account,
      this.region,
    ]);

    const imageBucket = new s3.Bucket(this, 'ImageBucket', {
      bucketName: imageBucketName,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
      serverAccessLogsBucket: logBucket,
      serverAccessLogsPrefix: 'image-bucket/',
      // CORS is attached after the distribution is created, so it can name the
      // exact origin instead of a wildcard. See the end of this constructor.
    });

    // --- Shared imaging layer (Pillow + numpy, built by scripts/build-layers.sh)
    const imagingLayer = new lambda.LayerVersion(this, 'ImagingLayer', {
      code: lambda.Code.fromAsset('layers/imaging'),
      compatibleRuntimes: [lambda.Runtime.PYTHON_3_14],
      compatibleArchitectures: [lambda.Architecture.ARM_64],
      description: 'Pillow + numpy for the image forensics signals',
    });

    const signalDefaults = {
      runtime: lambda.Runtime.PYTHON_3_14,
      architecture: lambda.Architecture.ARM_64,
      handler: 'handler.lambda_handler',
      memorySize: 1024,
      timeout: cdk.Duration.seconds(60),
      environment: { IMAGE_BUCKET: imageBucketName },
    };

    const bedrockPolicy = new iam.PolicyStatement({
      actions: ['bedrock:InvokeModel'],
      resources: [
        `arn:aws:bedrock:${this.region}:${this.account}:inference-profile/${bedrockModelId}`,
        'arn:aws:bedrock:*::foundation-model/anthropic.*',
      ],
    });

    // --- Signal functions --------------------------------------------------
    const bedrockFn = new lambda.Function(this, 'BedrockSignalFn', {
      ...signalDefaults,
      code: lambda.Code.fromAsset('../src/signals/bedrock_analysis'),
      timeout: cdk.Duration.seconds(90),
      environment: { ...signalDefaults.environment, BEDROCK_MODEL_ID: bedrockModelId },
    });
    bedrockFn.addToRolePolicy(bedrockPolicy);

    const elaFn = new lambda.Function(this, 'ElaSignalFn', {
      ...signalDefaults,
      code: lambda.Code.fromAsset('../src/signals/ela'),
      layers: [imagingLayer],
    });
    const fftFn = new lambda.Function(this, 'FftSignalFn', {
      ...signalDefaults,
      code: lambda.Code.fromAsset('../src/signals/fft'),
      layers: [imagingLayer],
    });
    const metadataFn = new lambda.Function(this, 'MetadataSignalFn', {
      ...signalDefaults,
      code: lambda.Code.fromAsset('../src/signals/metadata'),
      layers: [imagingLayer],
    });

    // Cross-evidence signal: re-reads the photo plus the ELA heatmap and FFT
    // spectrum in one Converse call, so the model interprets the artefacts in
    // context. Runs after the parallel branches that produce them.
    const crossEvidenceFn = new lambda.Function(this, 'CrossEvidenceSignalFn', {
      ...signalDefaults,
      code: lambda.Code.fromAsset('../src/signals/cross_evidence'),
      timeout: cdk.Duration.seconds(90),
      environment: { ...signalDefaults.environment, BEDROCK_MODEL_ID: bedrockModelId },
    });
    crossEvidenceFn.addToRolePolicy(bedrockPolicy);

    const aggregatorFn = new lambda.Function(this, 'AggregatorFn', {
      runtime: lambda.Runtime.PYTHON_3_14,
      architecture: lambda.Architecture.ARM_64,
      handler: 'handler.lambda_handler',
      code: lambda.Code.fromAsset('../src/aggregator'),
      memorySize: 256,
      timeout: cdk.Duration.seconds(30),
      environment: { TABLE_NAME: table.tableName },
    });
    table.grantWriteData(aggregatorFn);

    imageBucket.grantRead(bedrockFn);
    imageBucket.grantReadWrite(elaFn);
    imageBucket.grantReadWrite(fftFn);
    imageBucket.grantRead(metadataFn);
    imageBucket.grantRead(crossEvidenceFn);

    // --- Step Functions Express: parallel signals, then aggregation ---------
    const branch = (fn: lambda.Function, name: string) =>
      new tasks.LambdaInvoke(this, `${name}Task`, {
        lambdaFunction: fn,
        payload: sfn.TaskInput.fromObject({ 'imageKey.$': '$.imageKey' }),
        outputPath: '$.Payload',
      });

    const parallel = new sfn.Parallel(this, 'RunSignals', { resultPath: '$.signals' })
      .branch(branch(bedrockFn, 'BedrockSemantic'))
      .branch(branch(elaFn, 'ErrorLevelAnalysis'))
      .branch(branch(fftFn, 'FrequencyAnalysis'))
      .branch(branch(metadataFn, 'MetadataForensics'));

    const crossEvidence = new tasks.LambdaInvoke(this, 'CrossEvidenceTask', {
      lambdaFunction: crossEvidenceFn,
      payload: sfn.TaskInput.fromObject({
        'imageKey.$': '$.imageKey',
        'signals.$': '$.signals',
      }),
      resultSelector: { 'result.$': '$.Payload' },
      resultPath: '$.crossEvidence',
    });

    const aggregate = new tasks.LambdaInvoke(this, 'AggregateTask', {
      lambdaFunction: aggregatorFn,
      payload: sfn.TaskInput.fromObject({
        'imageKey.$': '$.imageKey',
        'signals.$':
          'States.Array($.signals[0], $.signals[1], $.signals[2], $.signals[3], $.crossEvidence.result)',
      }),
      outputPath: '$.Payload',
    });

    parallel.next(crossEvidence).next(aggregate);

    const stateMachine = new sfn.StateMachine(this, 'IntegrityPipeline', {
      stateMachineType: sfn.StateMachineType.EXPRESS,
      definitionBody: sfn.DefinitionBody.fromChainable(parallel),
      timeout: cdk.Duration.minutes(3),
      tracingEnabled: true,
      logs: {
        destination: new cdk.aws_logs.LogGroup(this, 'PipelineLogs', {
          retention: cdk.aws_logs.RetentionDays.ONE_WEEK,
          removalPolicy: cdk.RemovalPolicy.DESTROY,
        }),
        level: sfn.LogLevel.ALL,
      },
    });

    // --- Authentication ----------------------------------------------------
    // The API starts pipeline executions and issues presigned upload URLs, so
    // it requires a signed-in user. Create the first user with the AWS CLI:
    //   aws cognito-idp admin-create-user --user-pool-id <UserPoolId> \
    //     --username <email> --user-attributes Name=email,Value=<email>
    const userPool = new cognito.UserPool(this, 'ReviewerPool', {
      selfSignUpEnabled: false,
      signInAliases: { email: true },
      standardAttributes: { email: { required: true, mutable: false } },
      passwordPolicy: {
        minLength: 12,
        requireLowercase: true,
        requireUppercase: true,
        requireDigits: true,
        requireSymbols: true,
      },
      mfa: cognito.Mfa.OPTIONAL,
      mfaSecondFactor: { sms: false, otp: true },
      accountRecovery: cognito.AccountRecovery.EMAIL_ONLY,
      // The Plus feature plan turns on threat protection, which detects credential
      // stuffing and blocks compromised passwords. It is billed per monthly active
      // user; with a handful of reviewer accounts the charge is a few cents a month.
      featurePlan: cognito.FeaturePlan.PLUS,
      standardThreatProtectionMode: cognito.StandardThreatProtectionMode.FULL_FUNCTION,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });
    NagSuppressions.addResourceSuppressions(userPool, [
      {
        id: 'AwsSolutions-COG2',
        reason:
          'Time-based one-time password MFA is configured and available but not enforced, so the sample can be deployed and signed into without an enrolment step. Set mfa to Mfa.REQUIRED before accepting real submissions.',
      },
    ]);

    const userPoolClient = userPool.addClient('ReviewerClient', {
      authFlows: { userSrp: true },
      accessTokenValidity: cdk.Duration.hours(1),
      idTokenValidity: cdk.Duration.hours(1),
      preventUserExistenceErrors: true,
    });

    // --- API ---------------------------------------------------------------
    const apiFn = new lambda.Function(this, 'ApiFunction', {
      runtime: lambda.Runtime.PYTHON_3_14,
      architecture: lambda.Architecture.ARM_64,
      handler: 'handler.lambda_handler',
      code: lambda.Code.fromAsset('../src/api'),
      environment: {
        TABLE_NAME: table.tableName,
        IMAGE_BUCKET: imageBucketName,
        STATE_MACHINE_ARN: stateMachine.stateMachineArn,
      },
      timeout: cdk.Duration.seconds(29),
      memorySize: 256,
    });
    table.grantReadData(apiFn);
    imageBucket.grantReadWrite(apiFn);
    stateMachine.grantStartExecution(apiFn);

    // No Lambda function URL: the function sits behind an HTTP API, which
    // invokes it through a SourceArn-scoped permission, so the function's own
    // resource policy never grants public access.
    const httpApi = new apigwv2.HttpApi(this, 'IntegrityApi', {
      defaultAuthorizer: new authorizers.HttpUserPoolAuthorizer('ReviewerAuthorizer', userPool, {
        userPoolClients: [userPoolClient],
      }),
      defaultIntegration: new integrations.HttpLambdaIntegration('ApiIntegration', apiFn),
    });
    const apiEndpoint = `${httpApi.apiId}.execute-api.${this.region}.amazonaws.com`;
    NagSuppressions.addResourceSuppressions(
      httpApi,
      [
        {
          id: 'AwsSolutions-APIG1',
          reason:
            'Access logging on the HTTP API is left off to keep evaluation cost near zero. Enable an access log destination before production use.',
        },
      ],
      true,
    );

    for (const fn of [bedrockFn, elaFn, fftFn, metadataFn, crossEvidenceFn, aggregatorFn, apiFn]) {
      NagSuppressions.addResourceSuppressions(
        fn,
        [
          {
            id: 'AwsSolutions-IAM4',
            reason: 'AWSLambdaBasicExecutionRole is the minimal managed policy for CloudWatch Logs access.',
            appliesTo: [
              'Policy::arn:<AWS::Partition>:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole',
            ],
          },
          {
            id: 'AwsSolutions-IAM5',
            reason:
              'Object-level wildcards are scoped to this stack’s single image bucket; the Bedrock wildcard is scoped to Anthropic foundation models in the account’s partition.',
          },
        ],
        true,
      );
    }
    NagSuppressions.addResourceSuppressions(
      stateMachine,
      [
        {
          id: 'AwsSolutions-IAM5',
          reason: 'CDK-generated invoke grants use a version wildcard on the specific signal functions.',
        },
      ],
      true,
    );

    // --- Review UI: Amazon S3 (BLOCK_ALL) behind CloudFront with OAC --------
    const siteBucket = new s3.Bucket(this, 'SiteBucket', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      serverAccessLogsBucket: logBucket,
      serverAccessLogsPrefix: 'site-bucket/',
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });

    const distribution = new cloudfront.Distribution(this, 'SiteDistribution', {
      defaultBehavior: {
        origin: origins.S3BucketOrigin.withOriginAccessControl(siteBucket),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
      },
      additionalBehaviors: {
        // The API rides the same distribution so the UI calls a same-origin
        // /api path and needs no CORS configuration.
        '/api/*': {
          origin: new origins.HttpOrigin(apiEndpoint),
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.HTTPS_ONLY,
          allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
          cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
          originRequestPolicy: cloudfront.OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
        },
      },
      defaultRootObject: 'index.html',
      enableLogging: true,
      logBucket,
      logFilePrefix: 'cloudfront/',
      minimumProtocolVersion: cloudfront.SecurityPolicyProtocol.TLS_V1_2_2021,
    });
    NagSuppressions.addResourceSuppressions(distribution, [
      {
        id: 'AwsSolutions-CFR4',
        reason:
          'The distribution uses the default *.cloudfront.net certificate, which pins the minimum TLS version at the distribution level. Attach an ACM certificate for a custom domain to control the security policy directly.',
      },
      {
        id: 'AwsSolutions-CFR1',
        reason: 'Geographic restriction depends on where your reviewers work; add a geo restriction to match your operating regions.',
      },
      {
        id: 'AwsSolutions-CFR2',
        reason:
          'AWS WAF is not deployed because the API behind this distribution requires an authenticated Amazon Cognito token. Associate a web ACL if you expose the UI to untrusted networks.',
      },
    ]);

    new s3deploy.BucketDeployment(this, 'DeploySite', {
      sources: [
        s3deploy.Source.asset('../frontend/dist'),
        s3deploy.Source.jsonData('config.json', {
          apiUrl: '/api',
          region: this.region,
          userPoolId: userPool.userPoolId,
          userPoolClientId: userPoolClient.userPoolClientId,
        }),
      ],
      destinationBucket: siteBucket,
      distribution,
    });

    NagSuppressions.addResourceSuppressionsByPath(
      this,
      `/${this.stackName}/Custom::CDKBucketDeployment8693BB64968944B69AAFB0CC9EB8756C`,
      [
        {
          id: 'AwsSolutions-IAM4',
          reason: 'The CDK-managed BucketDeployment function uses the basic execution managed policy.',
        },
        {
          id: 'AwsSolutions-IAM5',
          reason: 'The CDK-managed BucketDeployment function needs object wildcards to copy assets between buckets.',
        },
        {
          id: 'AwsSolutions-L1',
          reason: 'The runtime of the CDK-managed BucketDeployment function is pinned by aws-cdk-lib, not by this application.',
        },
      ],
      true,
    );

    // Auto-delete-objects providers are CDK-managed singletons.
    for (const path of [
      `/${this.stackName}/Custom::S3AutoDeleteObjectsCustomResourceProvider/Role`,
    ]) {
      NagSuppressions.addResourceSuppressionsByPath(
        this,
        path,
        [
          {
            id: 'AwsSolutions-IAM4',
            reason: 'The CDK-managed auto-delete-objects provider uses the basic execution managed policy.',
          },
          {
            id: 'AwsSolutions-IAM5',
            reason: 'The CDK-managed auto-delete-objects provider needs object wildcards to empty the bucket on stack deletion.',
          },
        ],
        true,
      );
    }

    // --- Image bucket CORS -------------------------------------------------
    // Attached here, rather than in the bucket constructor, so it can name the
    // review interface's exact origin instead of a wildcard. Only PUT needs CORS:
    // uploads go straight to Amazon S3 with a presigned URL from the browser.
    // Presigned GET URLs are rendered in <img> elements, which are not subject to
    // CORS. Set uiOrigin in context if you serve the interface from your own
    // domain instead of the CloudFront one.
    const uiOrigin: string =
      this.node.tryGetContext('uiOrigin') ?? `https://${distribution.distributionDomainName}`;

    imageBucket.addCorsRule({
      allowedMethods: [s3.HttpMethods.PUT],
      allowedOrigins: [uiOrigin],
      allowedHeaders: ['content-type'],
      maxAge: 3000,
    });

    // --- Outputs -----------------------------------------------------------
    new cdk.CfnOutput(this, 'ReviewUrl', { value: `https://${distribution.distributionDomainName}` });
    new cdk.CfnOutput(this, 'UserPoolId', { value: userPool.userPoolId });
    new cdk.CfnOutput(this, 'UserPoolClientId', { value: userPoolClient.userPoolClientId });
    new cdk.CfnOutput(this, 'ImageBucketName', { value: imageBucketName });
    new cdk.CfnOutput(this, 'StateMachineArn', { value: stateMachine.stateMachineArn });
    new cdk.CfnOutput(this, 'TableName', { value: table.tableName });
  }
}
