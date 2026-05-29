import test from "node:test";
import assert from "node:assert/strict";
import planStepdownExtension from "./index.ts";

test("index: exports an extension factory", () => {
	assert.equal(typeof planStepdownExtension, "function");
});
