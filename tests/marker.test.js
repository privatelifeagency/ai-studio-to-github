// node --test tests/marker.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildMarkerContent, parseMarker, MARKER_FILENAME } from "../lib/marker.js";

test("MARKER_FILENAME constant", () => {
  assert.equal(MARKER_FILENAME, ".ghl-aistudio-sync.json");
});

test("buildMarkerContent round-trip with parseMarker", () => {
  const built = buildMarkerContent({
    projectId: "test-project-id-001",
    locationId: "test-location-id-abc",
    projectName: "Test Project",
    firstSyncedAt: "2026-01-01T00:00:00.000Z",
    lastSyncedAt: "2026-01-01T00:00:00.000Z",
    extensionVersion: "0.1.0",
  });
  // Pretty JSON ends with newline.
  assert.ok(built.endsWith("\n"));
  const parsed = parseMarker(built);
  assert.equal(parsed.projectId, "test-project-id-001");
  assert.equal(parsed.locationId, "test-location-id-abc");
  assert.equal(parsed.projectName, "Test Project");
  assert.equal(parsed.extensionVersion, "0.1.0");
  assert.equal(parsed.firstSyncedAt, "2026-01-01T00:00:00.000Z");
  assert.equal(parsed.lastSyncedAt, "2026-01-01T00:00:00.000Z");
  assert.equal(parsed.schema, "ghl-aistudio-sync@1");
});

test("buildMarkerContent coerces numeric IDs to strings", () => {
  const built = buildMarkerContent({
    projectId: 12345n,
    locationId: 42,
    firstSyncedAt: "t1",
    lastSyncedAt: "t1",
  });
  const parsed = parseMarker(built);
  assert.equal(typeof parsed.projectId, "string");
  assert.equal(typeof parsed.locationId, "string");
});

test("buildMarkerContent requires projectId and locationId", () => {
  assert.throws(() => buildMarkerContent({ locationId: "x" }), /projectId and locationId/);
  assert.throws(() => buildMarkerContent({ projectId: "x" }), /projectId and locationId/);
});

test("parseMarker returns null for non-string input", () => {
  assert.equal(parseMarker(null), null);
  assert.equal(parseMarker(undefined), null);
  assert.equal(parseMarker(123), null);
  assert.equal(parseMarker({}), null);
});

test("parseMarker returns null for empty/malformed JSON", () => {
  assert.equal(parseMarker(""), null);
  assert.equal(parseMarker("not json"), null);
  assert.equal(parseMarker("{bad json"), null);
});

test("parseMarker returns null when aiStudioProjectId is missing", () => {
  assert.equal(parseMarker(JSON.stringify({ foo: "bar" })), null);
  assert.equal(parseMarker(JSON.stringify({ aiStudioLocationId: "x" })), null);
});

test("parseMarker accepts marker without optional fields", () => {
  const r = parseMarker(JSON.stringify({ aiStudioProjectId: "abc" }));
  assert.equal(r.projectId, "abc");
  assert.equal(r.locationId, null);
  assert.equal(r.projectName, null);
  assert.equal(r.extensionVersion, null);
});
