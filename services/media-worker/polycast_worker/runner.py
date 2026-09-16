"""Task execution and the claim → run → report loop.

One bad task never crashes the loop: every failure inside a handler becomes a typed failed
TaskResult. Retryable is reserved for transient I/O (storage, tool timeouts); validation and
contract problems are terminal. Log lines carry ids, stages and durations only.
"""

from __future__ import annotations

import logging
import threading
import time
from collections.abc import Callable
from functools import partial

from pydantic import ValidationError

from .client import ApiClient, ApiError
from .models import OUTPUT_MODELS, Stage, TaskError, TaskResult, WorkerTask
from .providers.base import ProviderError
from .providers.registry import ProviderSet
from .stages import StageEnv, StageError, handler_for
from .storage import Storage, StorageError, StorageUriError
from .tools import ToolError, Tools

log = logging.getLogger("polycast_worker.runner")


def _failed(worker_id: str, code: str, message: str, retryable: bool) -> TaskResult:
    return TaskResult(
        status="failed",
        retryable=retryable,
        error=TaskError(code=code, message=message),
        output=None,
        workerId=worker_id,
    )


def run_task(
    task: WorkerTask,
    storage: Storage,
    tools: Tools,
    worker_id: str,
    env: StageEnv | None = None,
) -> TaskResult:
    """Run one task. `env` carries the provider registry and lease hooks; None = local mocks."""
    started = time.monotonic()
    result: TaskResult
    try:
        output = handler_for(task.stage)(task, storage, tools, env)
        OUTPUT_MODELS[task.stage].model_validate(output)
        result = TaskResult(
            status="succeeded", retryable=False, error=None, output=output, workerId=worker_id
        )
    except (StageError, ProviderError) as e:
        result = _failed(worker_id, e.code, e.message, e.retryable)
    except (ValidationError, StorageUriError, ValueError):
        result = _failed(
            worker_id,
            "INVALID_TASK",
            "Task parameters or stage output did not match the worker contract.",
            False,
        )
    except ToolError as e:
        code = "TOOL_UNAVAILABLE" if e.retryable else "MEDIA_PROCESSING_FAILED"
        result = _failed(worker_id, code, str(e), e.retryable)
    except StorageError as e:
        result = _failed(worker_id, "STORAGE_IO", str(e), True)
    except (OSError, MemoryError):
        result = _failed(worker_id, "TRANSIENT_IO", "The worker hit an I/O error.", True)
    except Exception as e:  # noqa: BLE001 - last line of defence; the loop must survive
        result = _failed(
            worker_id, "INTERNAL_ERROR", f"Unexpected {type(e).__name__} in stage handler.", False
        )
    elapsed_ms = int((time.monotonic() - started) * 1000)
    if result.status == "succeeded":
        log.info(
            "task %s stage %s attempt %d succeeded in %d ms",
            task.taskId,
            task.stage,
            task.attempt,
            elapsed_ms,
        )
    else:
        code = result.error.code if result.error else "UNKNOWN"
        log.warning(
            "task %s stage %s attempt %d failed code=%s retryable=%s in %d ms",
            task.taskId,
            task.stage,
            task.attempt,
            code,
            result.retryable,
            elapsed_ms,
        )
    return result


def _safe_heartbeat(client: ApiClient, task_id: str) -> None:
    """Lease renewal from inside a provider poll loop; a failed beat must not fail the task."""
    try:
        client.heartbeat(task_id)
    except ApiError:
        log.warning("heartbeat failed during provider poll (retrying at next poll)")


class Heartbeat:
    """Background lease renewal every `interval_s` while a task runs."""

    def __init__(self, beat: Callable[[], None], interval_s: float) -> None:
        self._beat = beat
        self._interval = max(0.05, interval_s)
        self._stop = threading.Event()
        self._thread = threading.Thread(target=self._loop, name="heartbeat", daemon=True)
        self.beats = 0

    def _loop(self) -> None:
        while not self._stop.wait(self._interval):
            try:
                self._beat()
                self.beats += 1
            except ApiError:
                log.warning("heartbeat failed (retrying at next interval)")

    def __enter__(self) -> Heartbeat:
        self._thread.start()
        return self

    def __exit__(self, *_: object) -> None:
        self._stop.set()
        self._thread.join(timeout=self._interval + 1.0)


def run_loop(
    client: ApiClient,
    storage: Storage,
    tools: Tools,
    *,
    once: bool = False,
    poll_interval_s: float = 2.0,
    stages: list[Stage] | None = None,
    sleep: Callable[[float], None] = time.sleep,
    max_tasks: int | None = None,
    providers: ProviderSet | None = None,
    provider_poll_interval_s: float = 5.0,
) -> int:
    """Claim and run tasks. With `once`, exit 0 at the first empty claim (204).

    Returns a process exit code. `max_tasks` is a safety valve for tests. `providers` is the
    registry built from configuration (None = the local mock set); `sleep` also paces
    provider polling, whose every iteration renews the task lease.
    """
    processed = 0
    if providers is None:
        providers = StageEnv.local(storage, tools).providers
    while max_tasks is None or processed < max_tasks:
        try:
            raw = client.claim_raw(stages)
        except ApiError as e:
            log.warning("claim failed: %s", e)
            if once or not e.retryable:
                return 1
            sleep(poll_interval_s)
            continue
        if raw is None:
            if once:
                return 0
            sleep(poll_interval_s)
            continue

        try:
            task = WorkerTask.model_validate(raw)
        except ValidationError:
            task_id = raw.get("taskId")
            log.warning("claimed task did not match the worker contract")
            if isinstance(task_id, str) and task_id:
                try:
                    client.post_result(
                        task_id,
                        _failed(
                            client.worker_id,
                            "INVALID_TASK",
                            "Task did not match the worker contract.",
                            False,
                        ),
                    )
                except ApiError:
                    log.warning("could not report invalid task %s", task_id)
            processed += 1
            continue

        log.info("claimed task %s stage %s attempt %d", task.taskId, task.stage, task.attempt)
        env = StageEnv(
            providers=providers,
            heartbeat=partial(_safe_heartbeat, client, task.taskId),
            sleep=sleep,
            poll_interval_s=provider_poll_interval_s,
        )
        with Heartbeat(partial(client.heartbeat, task.taskId), task.leaseSeconds / 3):
            result = run_task(task, storage, tools, client.worker_id, env)
        try:
            client.post_result(task.taskId, result)
        except ApiError as e:
            log.warning("could not post result for task %s: %s", task.taskId, e)
        processed += 1
    return 0
