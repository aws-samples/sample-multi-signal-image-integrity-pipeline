# Multi-signal image integrity pipeline

Sample code showing how to score user-uploaded images for signs of editing or synthetic
generation on AWS, and how to show a reviewer which check failed and why.

> This is sample code, for non-production usage. You should work with your security and legal
> teams to meet your organizational security, regulatory and compliance requirements before
> deployment.

## The problem this addresses

When a business decision depends on a photo somebody uploaded, whether that is an insurance
claim, an identity check, a condition assessment, or a marketplace listing, that photo can be
filtered, edited, or generated outright. Tools that score authenticity often return a single
number with no explanation, which leaves a human reviewer unable to act: they cannot tell
whether the score came from a pasted region, an implausible shadow, or a metadata tag, so they
cannot judge whether the score is right.

This sample takes a different approach. Five independent signals examine each image, each
reporting its own verdict and a written reason. An aggregator combines them into one score, and
the review interface shows the breakdown. When an image is flagged, the reviewer sees which
signal objected, how strongly, and on what evidence.

## Architecture

![Architecture: an image in Amazon S3 triggers an AWS Step Functions Express workflow with four parallel signal branches, followed by a cross-evidence signal and an aggregator that writes to Amazon DynamoDB. A Cloudscape review interface on Amazon S3 and Amazon CloudFront reads results through an authenticated Amazon API Gateway HTTP API.](docs/architecture.png)

An image arrives in Amazon S3, either seeded by script or uploaded through a presigned URL. An
AWS Step Functions Express workflow runs four signals in parallel, then runs a fifth that reads
the artefacts the earlier signals produced. An aggregator function writes the verdict and the
per-signal breakdown to Amazon DynamoDB. A Cloudscape single-page application, hosted on Amazon
S3 behind Amazon CloudFront, reads results through an Amazon API Gateway HTTP API that requires
an Amazon Cognito token.

```text
Amazon S3 (image)
  |
  v
AWS Step Functions Express
  |-- Semantic analysis        Amazon Bedrock, Converse API, multimodal
  |-- Error Level Analysis     AWS Lambda with Pillow, writes a heatmap
  |-- Frequency analysis       AWS Lambda with NumPy, writes a spectrum
  |-- Metadata forensics       AWS Lambda, reads EXIF
  |
  v
Cross-evidence review         Amazon Bedrock, reads the image with both artefacts
  |
  v
Aggregator -> Amazon DynamoDB (verdict and per-signal breakdown)
  ^
  |
Amazon API Gateway HTTP API (Amazon Cognito authorizer) <- Cloudscape review interface
```

## What each signal catches, and what it misses

No signal here is sufficient alone. The table is the honest version; read it before you decide
what this pipeline can do for you.

| Signal | Catches | Misses |
|---|---|---|
| Semantic analysis (Amazon Bedrock) | Implausible lighting and shadows, warped geometry, repeated or oversmooth texture, malformed text, with a written rationale | A pixel-accurate edit that leaves a plausible scene. Reads the image, so text in the image aimed at the model can influence it |
| Error Level Analysis | A region pasted in with a different compression history, localized on a heatmap | PNG input, uniformly re-saved JPEGs, fully generated images, global filters |
| Frequency analysis | Periodic spectral signatures characteristic of some generators | Generated images that have been resized, cropped, or re-compressed |
| Metadata forensics | Editing software tags, absent camera provenance, inconsistent timestamps | Anything, once EXIF is stripped or forged, which takes seconds |
| Cross-evidence review | Misreadings by the deterministic signals, by interpreting their artefacts in context | The same plausible edits the semantic signal misses. Reads the submitted photo too, so one crafted image can influence this signal and the semantic one together |

Two consequences worth stating plainly. First, this pipeline reduces how many images a person
must examine and explains the ones it surfaces; it does not decide fraud. Second, defeating it
is not difficult for someone who knows how it works, so treat the score as one input to a
decision rather than the decision.

The concrete version of that second point: the two model signals are the only ones that detect a
cleanly generated image, and they are the two that read the image and can be influenced by text
inside it. A pass must not be an automated clearance where submitters choose the bytes. T4 in
[docs/threat-model.md](docs/threat-model.md) gives the arithmetic and what the aggregator does
about it.

If you need stronger detection, train a model on your own labelled images and add it as a
further signal. The aggregator accepts any signal that returns the same shape, so an Amazon
SageMaker AI endpoint fits without changing the workflow.

## Prerequisites

- Node.js 20 or later, and Python 3.12 or later (the AWS Lambda functions run on Python 3.14)
- The AWS CDK CLI: `npm install -g aws-cdk`
- Credentials for an AWS account you can deploy into, and a bootstrapped CDK environment
- Access to a multimodal Anthropic Claude model in Amazon Bedrock, in your deployment region.
  Request it under Model access in the Amazon Bedrock console. The stack defaults to
  `anthropic.claude-sonnet-4-5-20250929-v1:0`; override with `-c bedrockModelId=...`, and use a
  cross-region inference profile prefix (`us.`, `eu.`, `apac.`) if your region needs one.

## Deploy

Build the AWS Lambda layer and the review interface, then deploy the stack.

```bash
./scripts/build-layers.sh
```

```bash
cd frontend && npm ci && npm run build
```

```bash
cd infra && npm ci && npx cdk deploy
```

Deployment prints the stack outputs, including `ReviewUrl`, `UserPoolId`, `ImageBucketName`, and
`StateMachineArn`.

The review interface requires a sign-in, and the user pool does not allow self-registration.
Create your reviewer account, substituting the `UserPoolId` output and your own email address.

```bash
aws cognito-idp admin-create-user --user-pool-id <UserPoolId> --username <you@example.com> --user-attributes Name=email,Value=<you@example.com>
```

Amazon Cognito emails a temporary password. The interface prompts you to replace it on first
sign-in.

## Test

Seed a set of images and run the pipeline over them, using the `ImageBucketName` and
`StateMachineArn` outputs.

```bash
python3 scripts/seed-data.py --bucket <ImageBucketName> --state-machine <StateMachineArn>
```

The script generates images and derives three variants that each exercise a different signal: a
copy with a region spliced in, an image carrying periodic texture, and an image whose pixels are
untouched but whose EXIF names an image editor. Open `ReviewUrl`, sign in, and choose Refresh.

Two rows are worth opening. The spliced copy shows Error Level Analysis flagging while metadata
passes, with the heatmap marking the pasted region. The editor-metadata image shows the inverse:
metadata flags, every pixel-level signal passes. That contrast is the argument for combining
signals rather than trusting one.

To score your own images, use Upload image in the interface. Uploads run through the same
pipeline.

## Tuning the aggregation

`src/aggregator/handler.py` holds the weights and the flag threshold. Error Level Analysis
carries the most weight because it localizes an edit rather than inferring one; metadata carries
the least because it is trivially forged.

The signals are scored in **two groups, judged independently**: the three deterministic signals
(Error Level Analysis, frequency, metadata; 0.60 of the weight) and the two model signals
(semantic, cross-evidence; 0.40). Each group's score is normalized within the weight actually
present in it, and an image is flagged when **either** group crosses `FLAG_THRESHOLD`, or when any
single signal flags with confidence at or above `HIGH_CONFIDENCE`. The last condition stops one
confident finding from being averaged away by four passes.

Two groups rather than one sum, because the model signals both read the submitted image and can be
influenced by text inside it. Under a single weighted sum, driving both to zero pulled the whole
score down far enough that a genuine deterministic finding could not reach the threshold. Scoring
each group on its own terms removes that. T4 in [docs/threat-model.md](docs/threat-model.md) has
the detail.

One number to know before you re-calibrate: when the deterministic signals find nothing they cap
their own scores in their handlers (Error Level Analysis and frequency at 0.3, metadata at 0.4), so
that group cannot exceed `(0.30x0.3 + 0.20x0.3 + 0.10x0.4) / 0.60 = 0.317`. Against the default
0.35 threshold that is a thin margin, deliberately: a real finding clears it easily, since an Error
Level Analysis flag at the minimum blob size scores about 0.7 and a metadata editor tag scores 0.85.
If you raise `FLAG_THRESHOLD` above roughly 0.32 without also raising those caps, you are relying
entirely on the high-confidence condition for deterministic flags.

These numbers are starting points, not measured ones. Before you rely on the verdict, run a set
of images you have already judged through the pipeline and compare. Raising the threshold means
fewer images reach a reviewer and more manipulated images pass; lowering it means the reverse.
Which error is worse is a decision about your business, not a default this sample can pick.

Each record also carries `deterministicScore`, `llmScore`, and `corroboration`, the last being
`deterministic`, `llm_only`, or `none`. A flag marked `llm_only` rests entirely on model judgement
with no injection-resistant corroboration, which the review interface says on the record.

`ELA_HOT_RATIO` and `ELA_MIN_BLOB` on the Error Level Analysis function control its
sensitivity, and `SUBJECT_CHECK` on the semantic function adds a second check for whether the
image is usable at all. Set it to a description of what a reviewer needs to see, for example
`the full width of the damaged panel is visible and in focus`, and the signal reports usability
and authenticity separately.

## Cost

Every component is serverless and idles at close to nothing. Cost is driven by the two Amazon
Bedrock calls per image, then by Amazon S3 storage. The Amazon Cognito Plus feature plan, which
provides threat protection, is billed per monthly active user; with a few reviewer accounts that
is a few cents a month. Check current pricing for your region before estimating at volume.

## Cleanup

```bash
cd infra && npx cdk destroy
```

All three buckets and the Amazon DynamoDB table are configured to be removed with the stack, so
the images and verdicts you loaded are deleted. Nothing survives except the CloudWatch log
group's remaining retention window.

## Security

Signal functions read from one bucket and write only their own artefacts. The API function sits
behind an Amazon API Gateway HTTP API with an Amazon Cognito authorizer, and has no function
URL. All three buckets block public access and require TLS. The image and site buckets write
Amazon S3 server access logs to the third bucket, which expires them after 90 days; raise the
`ExpireAccessLogs` rule in the stack if your own retention standard is longer, and note that
those logs are what let you reconstruct who read an image. Dependencies are pinned to exact
versions, and the build instructions use `npm ci` so a deployment resolves the same tree that
was tested. `cdk-nag` runs as a synthesis aspect, so a change that introduces a public bucket,
an unencrypted resource, or an overly broad IAM policy fails the build; every suppression in the
stack carries a written justification.

The image bucket's CORS rule allows one origin, the CloudFront domain of this stack, and one
method, `PUT`. Only the browser upload needs CORS; presigned `GET` URLs are rendered in `<img>`
elements, which CORS does not govern. If you serve the review interface from your own domain,
pass it with `-c uiOrigin=https://example.com`.

Before handling real submissions, review at least the following. Set `mfa` to `Mfa.REQUIRED` on
the user pool. Associate an AWS WAF web ACL with the CloudFront distribution. Enable Amazon API
Gateway access logging, and point-in-time recovery on the table if verdicts become a system of
record. Add a rate limit or usage plan to the API: each analyzed image costs two Amazon Bedrock
calls, so a signed-in user can drive spend. Partition access if your reviewers should not all
see the same queue, because every signed-in user can currently list every record.

Decide how you handle a pass. The two model signals read the submitted image, so a submitter who
controls the bytes can put text in the image aimed at the model, and those two signals are also the
only ones that detect a cleanly generated forgery. The aggregator clamps model confidence and scores
the deterministic and model groups separately so a suppressed model group cannot bury a deterministic
finding, but no scoring rule closes the underlying gap. If your submitters are adversarial, a pass
needs a human, or a detector of your own that does not read instructions. T4 in
[docs/threat-model.md](docs/threat-model.md) sets out the reasoning and the residual risk.

### Compliance is your responsibility

Images that people upload are often personal, and in some jurisdictions they are regulated
personal data. Under the AWS [shared responsibility model](https://aws.amazon.com/compliance/shared-responsibility-model/),
configuring this workload to meet a given framework is the deployer's job, not something the
sample can do for you. Depending on what you point it at:

- Health-related images may be protected health information, which brings HIPAA obligations and
  requires a Business Associate Addendum with AWS and use of HIPAA-eligible services.
- Images of people in the EU or UK are personal data under GDPR. Consider your lawful basis,
  data minimisation, retention limits, and how you would satisfy a subject access or erasure
  request.
- Images of payment cards or card data can bring the workload into PCI DSS scope.
- Biometric identifiers, including faces, are separately regulated in some jurisdictions, for
  example Illinois BIPA and several Australian state and federal regimes.

Decide how long you retain images, who can read them, and what your lawful basis is before you
point this at anything real. The sample deliberately sets no lifecycle policy on the image
bucket and no time-to-live on the table, because the right retention period is a decision about
your business. Consult [AWS Artifact](https://aws.amazon.com/artifact/) for compliance reports
and your own legal and privacy teams for the obligations that apply to you.

## Security issue notifications

If you discover a potential security issue in this project, please notify AWS/Amazon Security
via our [vulnerability reporting page](https://aws.amazon.com/security/vulnerability-reporting/).
Do not create a public GitHub issue.

## License

This library is licensed under the MIT-0 License. See the [LICENSE](LICENSE) file.
