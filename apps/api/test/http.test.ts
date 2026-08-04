import { describe, expect, it } from "vitest";
import { ApiError } from "../src/errors.js";
import { errorResponse } from "../src/http.js";

describe("errorResponse", () => {
	it("includes code only when ApiError has one", async () => {
		const withCode = errorResponse(
			undefined as never,
			new ApiError("timed out", 504, "generation_timeout"),
		);
		const withoutCode = errorResponse(
			undefined as never,
			new ApiError("conflict", 409),
		);

		expect(await withCode.json()).toEqual({
			status: "error",
			message: "timed out",
			code: "generation_timeout",
		});
		const bodyWithoutCode = await withoutCode.json();
		expect(bodyWithoutCode).toEqual({
			status: "error",
			message: "conflict",
		});
		expect(bodyWithoutCode).not.toHaveProperty("code");
	});
});
