import type { Context } from "hono";
import { ApiError } from "./errors.js";

export function errorResponse(c: Context, error: unknown) {
  if (error instanceof ApiError) {
    return new Response(
      JSON.stringify({ status: "error", message: error.message }),
      {
        status: error.status,
        headers: { "content-type": "application/json; charset=utf-8" },
      },
    );
  }

  return new Response(
    JSON.stringify({
      status: "error",
      message: error instanceof Error ? error.message : "internal error",
    }),
    {
      status: 500,
      headers: { "content-type": "application/json; charset=utf-8" },
    },
  );
}

export function asObject(value: unknown): Record<string, unknown> {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return {};
}

export function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function asStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}
