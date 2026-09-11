import { describe, expect, test } from "bun:test";

import {
  DecisionSchema,
  TicketIngestSchema,
  TicketResponseSchema,
} from "../src/schemas";

const validMessage = {
  role: "customer" as const,
  content: "My payment failed while upgrading to Pro.",
  timestamp: "2026-09-10T10:00:00+07:00",
};

const validTicket = {
  customer: {
    plan: "free",
    region: "Vietnam",
    seats: 1,
    tenure_months: 4,
    prior_ticket_count: 0,
  },
  messages: [validMessage],
};

const validDecision = {
  id: "decision_123",
  turn_id: "turn_123",
  schema_version: "1",
  urgency: "high" as const,
  extracted: {
    product_area: "billing",
    primary_issue_type: "payment_and_access",
    secondary_issue_types: ["upgrade_failure"],
    sentiment: "frustrated" as const,
    language: "en",
  },
  action: "route_to_specialist" as const,
  target_queue: "billing",
  rationale: "Reported duplicate charges and missing Pro access need human billing review.",
  evidence: [
    { message_id: "message_123", summary: "Customer reports multiple charges." },
  ],
  knowledge_refs: [],
  unresolved_questions: ["Which charges have settled?"],
  requires_human: true,
  execution: { status: "unknown" as const },
  tool_call_ids: [],
  status: "completed" as const,
};

describe("Task 02 ticket and decision schemas", () => {
  test("accepts a valid billing-shaped ticket", () => {
    expect(TicketIngestSchema.safeParse(validTicket).success).toBe(true);
  });

  test("accepts the structured billing decision and response", () => {
    expect(DecisionSchema.safeParse(validDecision).success).toBe(true);
    expect(
      TicketResponseSchema.safeParse({
        conversation_id: "conversation_123",
        turn_id: "turn_123",
        reply: "A billing specialist needs to investigate these reported charges.",
        decision: validDecision,
      }).success,
    ).toBe(true);
  });

  test("rejects unsupported message roles", () => {
    expect(
      TicketIngestSchema.safeParse({
        ...validTicket,
        messages: [{ ...validMessage, role: "system" }],
      }).success,
    ).toBe(false);
  });

  test("rejects timestamps without a timezone", () => {
    expect(
      TicketIngestSchema.safeParse({
        ...validTicket,
        messages: [{ ...validMessage, timestamp: "2026-09-10T10:00:00" }],
      }).success,
    ).toBe(false);
    expect(
      TicketIngestSchema.safeParse({
        ...validTicket,
        messages: [{ ...validMessage, timestamp: "not-a-timestamp" }],
      }).success,
    ).toBe(false);
  });

  test("rejects empty message content", () => {
    expect(
      TicketIngestSchema.safeParse({
        ...validTicket,
        messages: [{ ...validMessage, content: "   " }],
      }).success,
    ).toBe(false);
  });

  test("rejects invalid decision enum values", () => {
    expect(
      DecisionSchema.safeParse({ ...validDecision, urgency: "urgent" }).success,
    ).toBe(false);
    expect(
      DecisionSchema.safeParse({ ...validDecision, action: "refund" }).success,
    ).toBe(false);
  });

  test("requires at least one and no more than 100 initial messages", () => {
    expect(
      TicketIngestSchema.safeParse({ ...validTicket, messages: [] }).success,
    ).toBe(false);
    expect(
      TicketIngestSchema.safeParse({
        ...validTicket,
        messages: Array.from({ length: 101 }, (_, index) => ({
          ...validMessage,
          timestamp: `2026-09-10T10:${String(index % 60).padStart(2, "0")}:00+07:00`,
        })),
      }).success,
    ).toBe(false);
  });

  test("rejects a message over 8,000 characters", () => {
    expect(
      TicketIngestSchema.safeParse({
        ...validTicket,
        messages: [{ ...validMessage, content: "x".repeat(8_001) }],
      }).success,
    ).toBe(false);
  });

  test("rejects a thread over 100,000 accumulated characters", () => {
    expect(
      TicketIngestSchema.safeParse({
        ...validTicket,
        messages: Array.from({ length: 13 }, (_, index) => ({
          ...validMessage,
          content: "x".repeat(8_000),
          timestamp: `2026-09-10T10:${String(index).padStart(2, "0")}:00+07:00`,
        })),
      }).success,
    ).toBe(false);
  });
});
