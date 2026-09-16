"""Lazy boto3 client factory plus the ClientError → ProviderError mapping.

Clients are created on first use and cached per service name. Tests build the factory with
pre-made (stubbed) clients so no adapter ever needs credentials or a network.
"""

from __future__ import annotations

from typing import Any

from ..base import ProviderError

RETRYABLE_ERROR_CODES = frozenset(
    {
        "ThrottlingException",
        "Throttling",
        "TooManyRequestsException",
        "LimitExceededException",
        "ServiceUnavailableException",
        "ServiceUnavailable",
        "InternalFailure",
        "InternalServerException",
        "InternalServerError",
        "RequestTimeout",
        "RequestTimeoutException",
        "ModelNotReadyException",
        "ModelTimeoutException",
    }
)


class ClientFactory:
    def __init__(
        self,
        region: str = "us-east-1",
        *,
        endpoint_url: str | None = None,
        clients: dict[str, Any] | None = None,
    ) -> None:
        self.region = region
        self._endpoint_url = endpoint_url
        self._clients: dict[str, Any] = dict(clients or {})

    @classmethod
    def with_clients(cls, clients: dict[str, Any], region: str = "us-east-1") -> ClientFactory:
        return cls(region, clients=clients)

    def client(self, service: str) -> Any:
        cached = self._clients.get(service)
        if cached is not None:
            return cached
        import boto3

        kwargs: dict[str, Any] = {"region_name": self.region}
        if service == "s3" and self._endpoint_url:
            kwargs["endpoint_url"] = self._endpoint_url
        created = boto3.client(service, **kwargs)
        self._clients[service] = created
        return created


def error_code(exc: BaseException) -> str | None:
    response = getattr(exc, "response", None)
    if not isinstance(response, dict):
        return None
    error = response.get("Error")
    code = error.get("Code") if isinstance(error, dict) else None
    return str(code) if code else None


def provider_error(service: str, exc: BaseException) -> ProviderError:
    """Map a botocore exception to a typed ProviderError without leaking its payload."""
    code = error_code(exc)
    if code in RETRYABLE_ERROR_CODES:
        return ProviderError(
            "PROVIDER_THROTTLED", f"{service} is throttling or unavailable.", retryable=True
        )
    if code is None:
        # ConnectionError / EndpointConnectionError and friends carry no response.
        return ProviderError(
            "PROVIDER_UNAVAILABLE", f"{service} could not be reached.", retryable=True
        )
    return ProviderError("PROVIDER_ERROR", f"{service} rejected the request ({code}).")
