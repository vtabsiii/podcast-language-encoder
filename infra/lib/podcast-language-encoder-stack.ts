import * as cdk from 'aws-cdk-lib';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as sfn from 'aws-cdk-lib/aws-stepfunctions';
import * as tasks from 'aws-cdk-lib/aws-stepfunctions-tasks';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as logs from 'aws-cdk-lib/aws-logs';
import { Construct } from 'constructs';
import * as path from 'path';

export interface PodcastLanguageEncoderStackProps extends cdk.StackProps {
  /** ISO 639-1 codes the episode is translated and re-voiced into, e.g. ['es', 'fr']. */
  targetLanguages: string[];
}

/**
 * Pipeline:
 *
 *   upload audio to s3://<input>/episodes/<name>.mp3
 *     -> EventBridge (S3 object created)
 *     -> Step Functions
 *          1. Transcribe: StartTranscriptionJob (auto language identification)
 *          2. poll GetTranscriptionJob until COMPLETED
 *          3. Lambda: read transcript, Translate into each target language,
 *             write text + start async Polly synthesis into the output bucket
 *          4. poll Polly GetSpeechSynthesisTask for each task until completed
 *     -> s3://<output>/<episode>/<lang>/transcript.txt, audio.mp3, manifest.json
 */
export class PodcastLanguageEncoderStack extends cdk.Stack {
  public readonly inputBucket: s3.Bucket;
  public readonly outputBucket: s3.Bucket;
  public readonly stateMachine: sfn.StateMachine;

  constructor(scope: Construct, id: string, props: PodcastLanguageEncoderStackProps) {
    super(scope, id, props);

    // ---------------------------------------------------------------- storage
    const bucketDefaults: s3.BucketProps = {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      versioned: false,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    };

    this.inputBucket = new s3.Bucket(this, 'InputBucket', {
      ...bucketDefaults,
      eventBridgeEnabled: true,
      lifecycleRules: [{ abortIncompleteMultipartUploadAfter: cdk.Duration.days(2) }],
    });

    this.outputBucket = new s3.Bucket(this, 'OutputBucket', {
      ...bucketDefaults,
      lifecycleRules: [
        // Raw Transcribe job output is only needed until the Lambda has read it.
        { prefix: 'transcribe-raw/', expiration: cdk.Duration.days(7) },
      ],
    });

    // ------------------------------------------------------------ transcribe
    // Transcribe needs to read the input object and write its JSON output.
    const transcribeRole = new iam.Role(this, 'TranscribeDataAccessRole', {
      assumedBy: new iam.ServicePrincipal('transcribe.amazonaws.com'),
      description: 'Lets Amazon Transcribe read podcast audio and write raw transcripts',
    });
    this.inputBucket.grantRead(transcribeRole);
    this.outputBucket.grantWrite(transcribeRole, 'transcribe-raw/*');

    const startTranscription = new tasks.CallAwsService(this, 'StartTranscriptionJob', {
      service: 'transcribe',
      action: 'startTranscriptionJob',
      iamResources: ['*'],
      parameters: {
        // Job names must be unique per account; use the episode key + execution id.
        'TranscriptionJobName.$': "States.Format('{}-{}', $.episode.id, $$.Execution.Name)",
        IdentifyLanguage: true,
        Media: {
          'MediaFileUri.$':
            "States.Format('s3://{}/{}', $.detail.bucket.name, $.detail.object.key)",
        },
        OutputBucketName: this.outputBucket.bucketName,
        'OutputKey.$':
          "States.Format('transcribe-raw/{}/{}.json', $.episode.id, $$.Execution.Name)",
        JobExecutionSettings: {
          DataAccessRoleArn: transcribeRole.roleArn,
        },
      },
      resultPath: '$.transcription',
    });
    startTranscription.addRetry({
      errors: ['Transcribe.LimitExceededException'],
      interval: cdk.Duration.seconds(30),
      maxAttempts: 10,
      backoffRate: 2,
    });

    const getTranscription = new tasks.CallAwsService(this, 'GetTranscriptionJob', {
      service: 'transcribe',
      action: 'getTranscriptionJob',
      iamResources: ['*'],
      parameters: {
        'TranscriptionJobName.$': '$.transcription.TranscriptionJob.TranscriptionJobName',
      },
      resultPath: '$.transcription',
    });

    const waitForTranscription = new sfn.Wait(this, 'WaitForTranscription', {
      time: sfn.WaitTime.duration(cdk.Duration.seconds(30)),
    });

    const transcriptionFailed = new sfn.Fail(this, 'TranscriptionFailed', {
      cause: 'Amazon Transcribe reported the job as FAILED',
      errorPath: '$.transcription.TranscriptionJob.FailureReason',
    });

    // -------------------------------------------------------------- lambda
    const processTranscript = new NodejsFunction(this, 'ProcessTranscriptFn', {
      entry: path.join(__dirname, '..', 'lambda', 'process-transcript', 'index.ts'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_22_X,
      architecture: lambda.Architecture.ARM_64,
      memorySize: 1024,
      timeout: cdk.Duration.minutes(15),
      logGroup: new logs.LogGroup(this, 'ProcessTranscriptLogs', {
        retention: logs.RetentionDays.ONE_MONTH,
        removalPolicy: cdk.RemovalPolicy.DESTROY,
      }),
      environment: {
        OUTPUT_BUCKET: this.outputBucket.bucketName,
        TARGET_LANGUAGES: props.targetLanguages.join(','),
      },
      bundling: {
        minify: true,
        sourceMap: true,
        target: 'node22',
      },
    });
    this.outputBucket.grantReadWrite(processTranscript);
    processTranscript.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['translate:TranslateText', 'comprehend:DetectDominantLanguage'],
        resources: ['*'],
      }),
    );
    processTranscript.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['polly:StartSpeechSynthesisTask', 'polly:DescribeVoices'],
        resources: ['*'],
      }),
    );

    const translateAndSynthesize = new tasks.LambdaInvoke(this, 'TranslateAndSynthesize', {
      lambdaFunction: processTranscript,
      payload: sfn.TaskInput.fromObject({
        'episodeId.$': '$.episode.id',
        'sourceKey.$': '$.detail.object.key',
        'transcriptUri.$': '$.transcription.TranscriptionJob.Transcript.TranscriptFileUri',
        'sourceLanguageCode.$': '$.transcription.TranscriptionJob.LanguageCode',
      }),
      resultSelector: {
        'tasks.$': '$.Payload.pollyTasks',
        'manifestKey.$': '$.Payload.manifestKey',
      },
      resultPath: '$.synthesis',
      retryOnServiceExceptions: true,
    });

    // ---------------------------------------------------------------- polly
    const getSpeechTask = new tasks.CallAwsService(this, 'GetSpeechSynthesisTask', {
      service: 'polly',
      action: 'getSpeechSynthesisTask',
      iamResources: ['*'],
      parameters: { 'TaskId.$': '$.taskId' },
      resultSelector: {
        'status.$': '$.SynthesisTask.TaskStatus',
        'reason.$': '$.SynthesisTask.TaskStatusReason',
        'outputUri.$': '$.SynthesisTask.OutputUri',
      },
      resultPath: '$.result',
    });

    const waitForSpeech = new sfn.Wait(this, 'WaitForSpeech', {
      time: sfn.WaitTime.duration(cdk.Duration.seconds(20)),
    });

    const speechFailed = new sfn.Fail(this, 'SpeechSynthesisFailed', {
      cause: 'Amazon Polly reported the synthesis task as failed',
      errorPath: '$.result.reason',
    });

    const speechDone = new sfn.Pass(this, 'SpeechDone');

    const pollSpeech = getSpeechTask.next(
      new sfn.Choice(this, 'IsSpeechComplete')
        .when(sfn.Condition.stringEquals('$.result.status', 'completed'), speechDone)
        .when(sfn.Condition.stringEquals('$.result.status', 'failed'), speechFailed)
        .otherwise(waitForSpeech.next(getSpeechTask)),
    );

    const waitForAllSpeech = new sfn.Map(this, 'WaitForAllSpeechTasks', {
      itemsPath: '$.synthesis.tasks',
      maxConcurrency: 5,
      resultPath: '$.synthesis.results',
    });
    waitForAllSpeech.itemProcessor(pollSpeech);

    // ----------------------------------------------------------- definition
    // Derive a filesystem-safe episode id from the object key: "episodes/My Show.mp3" -> "My-Show".
    const deriveEpisodeId = new sfn.Pass(this, 'DeriveEpisodeId', {
      parameters: {
        'id.$':
          "States.ArrayGetItem(States.StringSplit(States.ArrayGetItem(States.StringSplit($.detail.object.key, '/'), States.MathAdd(States.ArrayLength(States.StringSplit($.detail.object.key, '/')), -1)), '.'), 0)",
      },
      resultPath: '$.episode',
    });

    const definition = deriveEpisodeId
      .next(startTranscription)
      .next(waitForTranscription)
      .next(getTranscription)
      .next(
        new sfn.Choice(this, 'IsTranscriptionComplete')
          .when(
            sfn.Condition.stringEquals(
              '$.transcription.TranscriptionJob.TranscriptionJobStatus',
              'COMPLETED',
            ),
            translateAndSynthesize
              .next(waitForAllSpeech)
              .next(new sfn.Succeed(this, 'EpisodeEncoded')),
          )
          .when(
            sfn.Condition.stringEquals(
              '$.transcription.TranscriptionJob.TranscriptionJobStatus',
              'FAILED',
            ),
            transcriptionFailed,
          )
          .otherwise(waitForTranscription),
      );

    this.stateMachine = new sfn.StateMachine(this, 'EncoderStateMachine', {
      definitionBody: sfn.DefinitionBody.fromChainable(definition),
      timeout: cdk.Duration.hours(6),
      tracingEnabled: true,
      logs: {
        destination: new logs.LogGroup(this, 'StateMachineLogs', {
          retention: logs.RetentionDays.ONE_MONTH,
        }),
        level: sfn.LogLevel.ERROR,
      },
    });
    // Step Functions passes the data-access role to Transcribe, so it must be allowed to.
    this.stateMachine.addToRolePolicy(
      new iam.PolicyStatement({ actions: ['iam:PassRole'], resources: [transcribeRole.roleArn] }),
    );
    // Transcribe reads the input and writes OutputBucketName with the caller's permissions.
    this.inputBucket.grantRead(this.stateMachine);
    this.outputBucket.grantWrite(this.stateMachine, 'transcribe-raw/*');

    // -------------------------------------------------------------- trigger
    new events.Rule(this, 'OnEpisodeUploaded', {
      description: 'Start the encoder when an episode lands in the input bucket',
      eventPattern: {
        source: ['aws.s3'],
        detailType: ['Object Created'],
        detail: {
          bucket: { name: [this.inputBucket.bucketName] },
          object: { key: [{ prefix: 'episodes/' }] },
        },
      },
      targets: [new targets.SfnStateMachine(this.stateMachine)],
    });

    // -------------------------------------------------------------- outputs
    new cdk.CfnOutput(this, 'InputBucketName', {
      value: this.inputBucket.bucketName,
      description: 'Upload episodes to s3://<this>/episodes/<name>.mp3',
    });
    new cdk.CfnOutput(this, 'OutputBucketName', { value: this.outputBucket.bucketName });
    new cdk.CfnOutput(this, 'StateMachineArn', { value: this.stateMachine.stateMachineArn });
    new cdk.CfnOutput(this, 'TargetLanguages', { value: props.targetLanguages.join(',') });
  }
}
