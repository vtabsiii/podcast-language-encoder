"""Amazon adapters (Transcribe, Translate, Bedrock, Polly, MediaConvert, SES).

Every adapter takes a `ClientFactory` so tests can inject `botocore.stub.Stubber`-wrapped
clients fed by recorded responses; nothing here opens a network connection on import.
All records register at tier "beta" (promotion is only via docs/quality-benchmark.md) with
dataPolicy "no-training".
"""

from .clients import ClientFactory

__all__ = ["ClientFactory"]
