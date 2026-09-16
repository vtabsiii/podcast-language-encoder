"""Stage handlers. Each is `run(task, storage, tools, env=None) -> dict` returning the stage's
output as defined by packages/contracts (`output-<stage>.schema.json`). `env` carries the
provider registry and lease hooks; when omitted the local mock set is used."""

from __future__ import annotations

from collections.abc import Callable

from ..models import Stage, WorkerTask
from ..storage import Storage
from ..tools import Tools
from . import (
    analyzing,
    encoding,
    lip_syncing,
    mixing,
    packaging,
    synthesizing,
    target_qa,
    timing,
    translating,
    validating,
)
from .common import StageEnv, StageError

Handler = Callable[[WorkerTask, Storage, Tools, StageEnv | None], dict[str, object]]

HANDLERS: dict[Stage, Handler] = {
    "VALIDATING": validating.run,
    "ANALYZING": analyzing.run,
    "TRANSLATING": translating.run,
    "SYNTHESIZING": synthesizing.run,
    "TIMING": timing.run,
    "LIP_SYNCING": lip_syncing.run,
    "MIXING": mixing.run,
    "ENCODING": encoding.run,
    "TARGET_QA": target_qa.run,
    "PACKAGING": packaging.run,
}


def handler_for(stage: Stage) -> Handler:
    try:
        return HANDLERS[stage]
    except KeyError as e:
        raise StageError("UNSUPPORTED_STAGE", f"no handler for stage {stage}") from e


__all__ = ["HANDLERS", "Handler", "StageEnv", "StageError", "handler_for"]
