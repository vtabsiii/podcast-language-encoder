import { describe, expect, test } from 'vitest';
import {
  StepFunctionsOrchestrator,
  type StepFunctionsClientPort,
} from '../src/orchestrator/step-functions.js';

function fakeClient() {
  const calls: { op: string; input: unknown }[] = [];
  const client: StepFunctionsClientPort = {
    startExecution: async (input) => {
      calls.push({ op: 'start', input });
      return { executionArn: `arn:aws:states:us-east-1:1:execution:parent:${input.name}` };
    },
    sendTaskSuccess: async (input) => void calls.push({ op: 'success', input }),
    sendTaskFailure: async (input) => void calls.push({ op: 'failure', input }),
    sendTaskHeartbeat: async (input) => void calls.push({ op: 'heartbeat', input }),
    stopExecution: async (input) => void calls.push({ op: 'stop', input }),
  };
  return { client, calls };
}

describe('StepFunctionsOrchestrator', () => {
  test('starts the parent execution named after the job with the fan-out input', async () => {
    const { client, calls } = fakeClient();
    const o = new StepFunctionsOrchestrator({ parentStateMachineArn: 'arn:parent', client });
    const arn = await o.startJob({
      jobId: 'j1',
      organizationId: 'o',
      projectId: 'p',
      correlationId: 'c',
      maxConcurrency: 4,
      targets: [{ targetJobId: 't1', locale: 'es-MX', lipSync: false }],
    });
    expect(arn).toContain('job-j1');
    expect(calls[0]).toMatchObject({
      op: 'start',
      input: { stateMachineArn: 'arn:parent', name: 'job-j1' },
    });
    expect(JSON.parse((calls[0]!.input as { input: string }).input).targets).toHaveLength(1);
  });

  test('maps stage results to task success/failure with retryable error names', async () => {
    const { client, calls } = fakeClient();
    const o = new StepFunctionsOrchestrator({ parentStateMachineArn: 'arn:parent', client });
    await o.completeStage('tok', { ok: true, nextState: 'SYNTHESIZING' });
    await o.completeStage('tok', {
      ok: false,
      code: 'PROVIDER_TIMEOUT',
      message: 'x',
      retryable: true,
    });
    await o.completeStage('tok', {
      ok: false,
      code: 'MALFORMED_MEDIA',
      message: 'y',
      retryable: false,
    });
    await o.heartbeat('tok');
    await o.cancel('arn:exec', 'user');
    expect(calls.map((c) => c.op)).toEqual(['success', 'failure', 'failure', 'heartbeat', 'stop']);
    expect((calls[1]!.input as { error: string }).error).toBe('StageRetryable');
    expect((calls[2]!.input as { error: string }).error).toBe('StageFailed');
  });
});
