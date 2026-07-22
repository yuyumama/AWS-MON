"""OpenRouter（OpenAI互換API）向けのモデル実装。

OpenRouter無料枠のNemotron系などは response_format（OpenAIネイティブの構造化出力）に
非対応のため、Strands 標準の `OpenAIModel.structured_output()`（`beta.chat.completions.parse`）
がそのままでは使えない。ツール呼び出し（tools / tool_choice）には対応しているので、
Pydanticスキーマを function tool として渡し tool_choice で呼び出しを強制する方式で
structured_output を実装し直す（Bedrock / LiteLLM の structured_output と同じ機構）。
"""

from __future__ import annotations

from collections.abc import AsyncGenerator
from typing import Any, TypeVar, cast

from pydantic import BaseModel
from strands.models.openai import OpenAIModel
from strands.tools import convert_pydantic_to_tool_spec
from strands.types.content import Messages
from strands.types.tools import ToolChoice
from typing_extensions import override

T = TypeVar("T", bound=BaseModel)


class ToolCallStructuredOutputModel(OpenAIModel):
    """structured_output をツール呼び出しで実装するOpenAI互換モデル。"""

    @override
    async def structured_output(
        self,
        output_model: type[T],
        prompt: Messages,
        system_prompt: str | None = None,
        **kwargs: Any,
    ) -> AsyncGenerator[dict[str, T | Any], None]:
        tool_spec = convert_pydantic_to_tool_spec(output_model)
        request = self.format_request(
            prompt,
            tool_specs=[tool_spec],
            system_prompt=system_prompt,
            tool_choice=cast(ToolChoice, {"tool": {"name": tool_spec["name"]}}),
        )
        request["stream"] = False
        request.pop("stream_options", None)

        async with self._get_client() as client:
            response = await client.chat.completions.create(**request)

        if not response.choices:
            raise ValueError("No choices found in the response.")
        message = response.choices[0].message
        if not message.tool_calls:
            raise ValueError("No tool use was found in the response.")

        yield {
            "output": output_model.model_validate_json(
                message.tool_calls[0].function.arguments
            )
        }
