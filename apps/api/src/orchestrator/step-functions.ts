import type { JobState } from '@polycast/domain';

/**
 * Step Functions orchestration adapter (ADR-0004, M2). The parent state machine fans out one
 * child execution per TargetJob; each stage is an SQS message carrying a task token that the
 * media worker returns through the API. This module owns only the AWS calls, behind a port so
 * it is unit-testable; the persistence of stage results stays in LocalOrchestrator, which both
 * orchestrators share. Wiring it as the live orchestrator is the M2 deploy smoke test.
 */
export interface StepFunctionsClientPort {
  startExecution(input: {
    stateMachineArn: string;
    name: string;
    input: string;
  }): Promise<{ executionArn: string }>;
  sendTaskSuccess(input: { taskToken: string; output: string }): Promise<void>;
  sendTaskFailure(input: { taskToken: string; error: string; cause: string }): Promise<void>;
  sendTaskHeartbeat(input: { taskToken: string }): Promise<void>;
  stopExecution(input: { executionArn: string; cause: string }): Promise<void>;
}

export interface StepFunctionsOptions {
  parentStateMachineArn: string;
  client: StepFunctionsClientPort;
}

export interface FanOutInput {
  jobId: string;
  organizationId: string;
  projectId: string;
  correlationId: string;
  maxConcurrency: number;
  targets: { targetJobId: string; locale: string; lipSync: boolean }[];
}

export class StepFunctionsOrchestrator {
  constructor(private readonly opts: StepFunctionsOptions) {}

  /** Execution names are unique per account; the job id is a UUID v7 so it is safe and sortable. */
  async startJob(input: FanOutInput): Promise<string> {
    const { executionArn } = await this.opts.client.startExecution({
      stateMachineArn: this.opts.parentStateMachineArn,
      name: `job-${input.jobId}`,
      input: JSON.stringify(input),
    });
    return executionArn;
  }

  /** Called by the internal result endpoint when a task carries a Step Functions token. */
  async completeStage(
    taskToken: string,
    result:
      | { ok: true; nextState: JobState | null }
      | { ok: false; code: string; message: string; retryable: boolean },
  ): Promise<void> {
    if (result.ok) {
      await this.opts.client.sendTaskSuccess({
        taskToken,
        output: JSON.stringify({ nextState: result.nextState }),
      });
      return;
    }
    // Retryable failures surface as a distinct error name so the state machine's Retry matches it.
    await this.opts.client.sendTaskFailure({
      taskToken,
      error: result.retryable ? 'StageRetryable' : 'StageFailed',
      cause: JSON.stringify({ code: result.code, message: result.message }),
    });
  }

  async heartbeat(taskToken: string): Promise<void> {
    await this.opts.client.sendTaskHeartbeat({ taskToken });
  }

  async cancel(executionArn: string, cause: string): Promise<void> {
    await this.opts.client.stopExecution({ executionArn, cause });
  }
}

/** Real client over @aws-sdk/client-sfn, created lazily so local mode never loads the SDK. */
export async function createSfnClientPort(region: string): Promise<StepFunctionsClientPort> {
  const sfn = await import('@aws-sdk/client-sfn');
  const client = new sfn.SFNClient({ region });
  return {
    startExecution: async (input) => {
      const res = await client.send(new sfn.StartExecutionCommand(input));
      if (!res.executionArn) throw new Error('StartExecution returned no executionArn');
      return { executionArn: res.executionArn };
    },
    sendTaskSuccess: async (input) => {
      await client.send(new sfn.SendTaskSuccessCommand(input));
    },
    sendTaskFailure: async (input) => {
      await client.send(new sfn.SendTaskFailureCommand(input));
    },
    sendTaskHeartbeat: async (input) => {
      await client.send(new sfn.SendTaskHeartbeatCommand(input));
    },
    stopExecution: async (input) => {
      await client.send(new sfn.StopExecutionCommand(input));
    },
  };
}
