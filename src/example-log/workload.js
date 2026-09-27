// @ts-nocheck — mongosh script; `db`, `Mongo`, `print`, `sleep` and `process` are shell globals.
/* global db, Mongo, print, sleep, process */
// Workload behind the example log the app serves. It plays a multi-tenant
// helpdesk SaaS for a few minutes: several services talk to the database
// under their own appName, one tenant is far larger than the rest, and a
// mix of dashboard reads, scheduled jobs, reporting, an index build and an
// ad-hoc shell session produce the operations that end up over the slow
// threshold.
//
// Seeding runs with the threshold raised so it stays out of the log; the
// run itself uses the server default of 100 ms, so every entry is one an
// operator would actually see.
//
// Data is synthetic. Names, emails and text are generated.

const port = process.env.WORKLOAD_PORT ?? "27017";
// Set WORKLOAD_SKIP_SEED=1 to replay the traffic against an already seeded server.
const skipSeed = process.env.WORKLOAD_SKIP_SEED === "1";
const seedThresholdMs = 1_000_000_000;
const slowThresholdMs = 100;

// --- Deterministic pseudo-randomness ------------------------------------

let seed = 0x9e3779b9;
function rand() {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = seed;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
function pick(list) {
  return list[Math.floor(rand() * list.length)];
}
function between(min, max) {
  return min + Math.floor(rand() * (max - min + 1));
}

// --- Domain --------------------------------------------------------------

const anchor = new Date("2026-09-01T00:00:00Z").getTime();
const day = 86_400_000;

const statuses = ["open", "pending", "on_hold", "solved", "closed"];
const statusWeights = [0.18, 0.12, 0.05, 0.3, 0.35];
const priorities = ["low", "normal", "high", "urgent"];
const channels = ["email", "web", "chat", "api", "phone"];
const locales = ["en", "de", "fr", "es", "pt-BR", "ja"];
const tagPool = [
  "billing",
  "login",
  "refund",
  "bug",
  "feature-request",
  "outage",
  "mobile",
  "integration",
  "vip",
  "escalated",
  "duplicate",
  "spam",
];
const subjectPool = [
  "Cannot sign in after password reset",
  "Invoice shows wrong amount",
  "Refund not received",
  "Export stuck at 99%",
  "Webhook retries flooding our endpoint",
  "Two-factor codes arrive late",
  "Feature request: bulk archive",
  "Dashboard loads blank in Safari",
  "API rate limit lower than documented",
  "Seat count mismatch on renewal",
  "SSO login loops back to the sign-in page",
  "Attachment upload fails over 25 MB",
  "Report scheduled weekly never arrives",
  "Mobile app crashes on launch",
  "Wrong currency on receipts",
];
const firstNames = [
  "Ada",
  "Bruno",
  "Chen",
  "Dana",
  "Emeka",
  "Fatima",
  "Gita",
  "Hugo",
  "Ines",
  "Jonas",
  "Kai",
  "Lena",
  "Mateo",
  "Noor",
  "Olu",
  "Priya",
];
const lastNames = [
  "Alvarez",
  "Brandt",
  "Costa",
  "Dubois",
  "Eriksen",
  "Fischer",
  "Gupta",
  "Haddad",
  "Ivanova",
  "Jensen",
  "Kimura",
  "Lund",
  "Moreau",
  "Nakamura",
  "Okafor",
  "Petrov",
];
const mailDomains = [
  "example.com",
  "example.org",
  "example.net",
  "mail.example",
  "corp.example",
];

const orgCount = 1200;
const ticketCount = 600_000;
const eventCount = 1_200_000;
const agentCount = 8_000;
const articleCount = 20_000;
const invoiceCount = 240_000;

// Tenant skew: two large customers own most of the data.
function orgFor(i) {
  const r = (i * 2654435761) % 1000;
  if (r < 320) return "org_0001";
  if (r < 440) return "org_0002";
  if (r < 520) return "org_0003";
  return `org_${String(1 + (r % orgCount)).padStart(4, "0")}`;
}
function weighted(values, weights) {
  let r = rand();
  for (let i = 0; i < values.length; i++) {
    r -= weights[i];
    if (r <= 0) return values[i];
  }
  return values[values.length - 1];
}
function personName() {
  return `${pick(firstNames)} ${pick(lastNames)}`;
}
function email(name, domain) {
  return `${name.toLowerCase().replace(" ", ".")}${between(1, 999)}@${domain}`;
}

// --- Connections ---------------------------------------------------------

function service(appName) {
  return new Mongo(`mongodb://127.0.0.1:${port}/?appName=${appName}`);
}
const supportWeb = service("support-web").getDB("support");
const slaMonitor = service("sla-monitor").getDB("support");
const reporting = service("reporting-worker").getDB("support");
const indexer = service("search-indexer").getDB("support");
const billing = service("billing-service").getDB("billing");
const shell = db.getSiblingDB("support"); // the interactive mongosh session

// --- Seed ----------------------------------------------------------------

function bulk(coll, count, make) {
  const batch = [];
  for (let i = 0; i < count; i++) {
    batch.push(make(i));
    if (batch.length === 5000) {
      coll.insertMany(batch, { ordered: false });
      batch.length = 0;
    }
  }
  if (batch.length) coll.insertMany(batch, { ordered: false });
}

function seedDatabase() {
  db.setProfilingLevel(0, { slowms: seedThresholdMs });
  shell.dropDatabase();
  db.getSiblingDB("billing").dropDatabase();

  bulk(shell.orgs, orgCount, (i) => ({
    _id: `org_${String(i + 1).padStart(4, "0")}`,
    name: `${pick(lastNames)} ${pick(["Labs", "Logistics", "Health", "Media", "Retail", "Energy"])}`,
    plan: i < 3 ? "enterprise" : i % 7 === 0 ? "business" : "team",
    region: pick(["us", "eu", "apac"]),
    createdAt: new Date(anchor - between(30, 900) * day),
  }));

  bulk(shell.agents, agentCount, (i) => {
    const name = personName();
    return {
      _id: `agt_${String(i + 1).padStart(5, "0")}`,
      orgId: orgFor(i),
      name,
      email: `${name.toLowerCase().replace(" ", ".")}.${i}@corp.example`,
      role: i % 25 === 0 ? "admin" : "agent",
      active: i % 11 !== 0,
      lastSeenAt: new Date(anchor - between(0, 40) * day),
    };
  });

  bulk(shell.tickets, ticketCount, (i) => {
    const orgId = orgFor(i);
    const status = weighted(statuses, statusWeights);
    const createdAt = new Date(
      anchor - between(0, 365) * day - between(0, day),
    );
    const updatedAt = new Date(
      createdAt.getTime() + between(0, 20) * day + between(0, day),
    );
    const requester = personName();
    const tags = [];
    for (const tag of tagPool) if (rand() < 0.12) tags.push(tag);
    const solved = status === "solved" || status === "closed";
    return {
      orgId,
      number: i + 1,
      status,
      priority: weighted(priorities, [0.35, 0.45, 0.15, 0.05]),
      channel: pick(channels),
      subject: pick(subjectPool),
      requester: {
        name: requester,
        email: email(requester, pick(mailDomains)),
      },
      assigneeId:
        rand() < 0.8
          ? `agt_${String(between(1, agentCount)).padStart(5, "0")}`
          : null,
      tags,
      sla: {
        dueAt: new Date(createdAt.getTime() + between(4, 72) * 3_600_000),
        breached: rand() < 0.07,
      },
      satisfaction: solved && rand() < 0.4 ? between(1, 5) : null,
      createdAt,
      updatedAt,
      solvedAt: solved ? updatedAt : null,
      custom: {
        product: pick(["core", "mobile", "api", "billing"]),
        accountTier: pick(["free", "pro", "enterprise"]),
      },
    };
  });

  bulk(shell.ticket_events, eventCount, (i) => {
    const ticketNumber = between(1, ticketCount);
    return {
      orgId: orgFor(ticketNumber - 1),
      ticketNumber,
      type: pick(["comment", "comment", "status_change", "assignment", "note"]),
      actorId: `agt_${String(between(1, agentCount)).padStart(5, "0")}`,
      at: new Date(anchor - between(0, 365) * day - between(0, day)),
      body:
        rand() < 0.6
          ? `Followed up with the requester about "${pick(subjectPool).toLowerCase()}".`
          : null,
    };
  });

  bulk(shell.kb_articles, articleCount, (i) => ({
    orgId: orgFor(i),
    title: pick(subjectPool).replace(
      /^Cannot|^Feature request: /,
      "How to fix",
    ),
    locale: pick(locales),
    tags: [pick(tagPool), pick(tagPool)],
    body: "Lorem ipsum dolor sit amet, consectetur adipiscing elit. ".repeat(
      between(3, 20),
    ),
    views: between(0, 50_000),
    published: i % 5 !== 0,
    updatedAt: new Date(anchor - between(0, 500) * day),
  }));

  bulk(billing.invoices, invoiceCount, (i) => {
    const issuedAt = new Date(anchor - between(0, 730) * day);
    return {
      orgId: orgFor(i),
      period: issuedAt.toISOString().slice(0, 7),
      amountCents: between(4_900, 2_400_000),
      currency: pick(["USD", "USD", "EUR", "GBP"]),
      status: weighted(
        ["paid", "open", "overdue", "void"],
        [0.8, 0.1, 0.06, 0.04],
      ),
      issuedAt,
    };
  });

  shell.tickets.createIndex({ orgId: 1, number: 1 }, { unique: true });
  shell.tickets.createIndex({ orgId: 1, status: 1, updatedAt: -1 });
  shell.tickets.createIndex({ orgId: 1, createdAt: -1 });
  shell.tickets.createIndex({ orgId: 1, "requester.email": 1 });
  shell.tickets.createIndex({ orgId: 1, tags: 1 });
  shell.ticket_events.createIndex({ orgId: 1, ticketNumber: 1, at: 1 });
  shell.ticket_events.createIndex({ orgId: 1, at: -1 });
  shell.agents.createIndex({ orgId: 1, email: 1 }, { unique: true });
  shell.kb_articles.createIndex({ orgId: 1, locale: 1, updatedAt: -1 });
  billing.invoices.createIndex({ orgId: 1, period: 1 });
}

if (!skipSeed) seedDatabase();
db.setProfilingLevel(0, { slowms: slowThresholdMs });
print("seeded; slow threshold now " + slowThresholdMs + " ms");

// --- Traffic --------------------------------------------------------------

const bigOrg = "org_0001";
const midOrg = "org_0002";
const now = new Date(anchor);
const agentsOfBigOrg = shell.agents
  .find({ orgId: bigOrg, active: true }, { _id: 1 })
  .limit(12)
  .toArray()
  .map((a) => a._id);

// The inbox query most agents hit: the index covers org and status, the
// assignee filter runs against every open ticket of the tenant.
function inbox(orgId, assigneeId) {
  supportWeb.tickets
    .find({
      $and: [
        { orgId: { $eq: orgId } },
        {
          $and: [
            {
              $or: [
                { status: { $eq: "open" } },
                { status: { $eq: "pending" } },
              ],
            },
            { assigneeId: { $eq: assigneeId } },
          ],
        },
      ],
    })
    .sort({ updatedAt: -1 })
    .limit(25)
    .comment("inbox:assigned")
    .toArray();
}

function dashboard(orgId) {
  supportWeb.tickets
    .aggregate([
      { $match: { orgId, status: { $in: ["open", "pending", "on_hold"] } } },
      {
        $group: {
          _id: { status: "$status", priority: "$priority" },
          count: { $sum: 1 },
          oldest: { $min: "$createdAt" },
        },
      },
      { $sort: { "_id.status": 1, "_id.priority": 1 } },
    ])
    .toArray();
  supportWeb.tickets.countDocuments({
    orgId,
    status: "open",
    "sla.breached": true,
  });
}

function requesterHistory(orgId, domain) {
  supportWeb.tickets
    .find({
      orgId,
      "requester.email": { $regex: `@${domain.replace(".", "\\.")}$` },
    })
    .sort({ createdAt: -1 })
    .limit(50)
    .toArray();
}

function searchSubjects(orgId, term) {
  supportWeb.tickets
    .find({ orgId, subject: { $regex: term, $options: "i" } })
    .limit(20)
    .comment("search:subject")
    .toArray();
}

// Runs on a schedule across every tenant, so no index has a prefix for it.
function slaTick() {
  slaMonitor.tickets
    .find(
      {
        status: { $in: ["open", "pending"] },
        "sla.dueAt": { $gte: new Date(now.getTime() - 3_600_000), $lt: now },
        "sla.breached": false,
      },
      { orgId: 1, number: 1, "sla.dueAt": 1 },
    )
    .comment("sla:due-last-hour")
    .toArray();
  slaMonitor.tickets.count({
    status: "open",
    "sla.dueAt": { $lt: now },
    "sla.breached": false,
  });
}

function recentMentions(orgId, term) {
  try {
    supportWeb.ticket_events
      .find({ orgId, type: "comment", body: { $regex: term, $options: "i" } })
      .sort({ at: -1 })
      .limit(20)
      .maxTimeMS(500)
      .comment("widget:recent-mentions")
      .toArray();
  } catch {
    // The deadline is the point: the timeout is still logged as a slow query.
  }
}

function claimNext(orgId, assigneeId) {
  supportWeb.tickets.findOneAndUpdate(
    { orgId, status: { $ne: "closed" }, assigneeId: null },
    { $set: { assigneeId, updatedAt: now } },
    { sort: { priority: -1, createdAt: 1 }, returnDocument: "after" },
  );
}

// -- Morning: dashboards and inboxes for the big tenants -------------------

inbox("org_0412", "agt_00042");
for (const agentId of agentsOfBigOrg.slice(0, 6)) {
  inbox(bigOrg, agentId);
  sleep(between(400, 1500));
}
dashboard(bigOrg);
slaTick();
dashboard(midOrg);
requesterHistory(bigOrg, "example.org");
searchSubjects(bigOrg, "refund");
for (const agentId of agentsOfBigOrg.slice(6, 9)) {
  inbox(bigOrg, agentId);
  sleep(between(300, 900));
}
claimNext(bigOrg, agentsOfBigOrg[0]);
claimNext(bigOrg, agentsOfBigOrg[1]);
recentMentions(bigOrg, "chargeback");
sleep(4000);

// -- Billing close and the search indexer's catch-up scan ------------------

billing.invoices
  .aggregate([
    { $match: { status: { $in: ["open", "overdue"] } } },
    {
      $group: {
        _id: { orgId: "$orgId", currency: "$currency" },
        outstanding: { $sum: "$amountCents" },
        invoices: { $sum: 1 },
      },
    },
    { $sort: { outstanding: -1 } },
    { $limit: 100 },
  ])
  .toArray();
billing.invoices.find({ status: "overdue" }).sort({ issuedAt: 1 }).toArray();
billing.invoices.updateMany(
  { status: "open", issuedAt: { $lt: new Date(anchor - 45 * day) } },
  { $set: { status: "overdue" } },
);

indexer.tickets
  .find({ updatedAt: { $gte: new Date(anchor - 6 * 3_600_000) } })
  .batchSize(1000)
  .comment("indexer:catch-up")
  .toArray();
indexer.tickets.distinct("subject", { orgId: bigOrg });
indexer.kb_articles
  .find({ published: true, body: { $regex: "consectetur" } })
  .limit(100)
  .toArray();
slaTick();
sleep(3000);

// -- Reporting burst -------------------------------------------------------

reporting.tickets
  .aggregate([
    { $match: { solvedAt: { $gte: new Date(anchor - 90 * day) } } },
    {
      $group: {
        _id: "$orgId",
        solved: { $sum: 1 },
        avgResolutionMs: { $avg: { $subtract: ["$solvedAt", "$createdAt"] } },
        csat: { $avg: "$satisfaction" },
      },
    },
    { $sort: { solved: -1 } },
    { $limit: 50 },
  ])
  .toArray();

reporting.tickets
  .aggregate(
    [
      { $match: { orgId: bigOrg, status: { $in: ["solved", "closed"] } } },
      { $sort: { solvedAt: -1 } },
      {
        $lookup: {
          from: "agents",
          localField: "assigneeId",
          foreignField: "_id",
          as: "assignee",
        },
      },
      { $unwind: { path: "$assignee", preserveNullAndEmptyArrays: true } },
      {
        $project: {
          number: 1,
          subject: 1,
          solvedAt: 1,
          "assignee.name": 1,
          "assignee.email": 1,
        },
      },
    ],
    { allowDiskUse: true, cursor: { batchSize: 1000 } },
  )
  .toArray();

reporting.tickets
  .aggregate([
    { $match: { orgId: bigOrg } },
    {
      $facet: {
        byChannel: [{ $sortByCount: "$channel" }],
        byPriority: [{ $sortByCount: "$priority" }],
        breached: [{ $match: { "sla.breached": true } }, { $count: "n" }],
      },
    },
  ])
  .toArray();

reporting.ticket_events
  .aggregate([
    { $match: { at: { $gte: new Date(anchor - 30 * day) } } },
    {
      $group: {
        _id: {
          day: { $dateTrunc: { date: "$at", unit: "day" } },
          type: "$type",
        },
        n: { $sum: 1 },
      },
    },
    { $sort: { "_id.day": 1 } },
  ])
  .toArray();

reporting.tickets
  .aggregate([
    {
      $match: {
        orgId: bigOrg,
        createdAt: { $gte: new Date(anchor - 30 * day) },
      },
    },
    { $unwind: "$tags" },
    { $group: { _id: "$tags", n: { $sum: 1 } } },
    { $sort: { n: -1 } },
  ])
  .toArray();

reporting.tickets
  .aggregate(
    [
      {
        $group: {
          _id: "$requester.email",
          tickets: { $push: "$$ROOT" },
        },
      },
      { $match: { "tickets.1": { $exists: true } } },
      { $count: "repeatRequesters" },
    ],
    { allowDiskUse: true, comment: "report:repeat-requesters" },
  )
  .toArray();

// Suggests articles per open ticket; nothing indexes kb_articles.tags, so
// every batch of the cursor re-scans the article collection per ticket.
reporting.tickets
  .aggregate(
    [
      {
        $match: { orgId: bigOrg, status: "open", "tags.0": { $exists: true } },
      },
      { $limit: 1200 },
      {
        $lookup: {
          from: "kb_articles",
          localField: "tags",
          foreignField: "tags",
          as: "suggested",
        },
      },
      { $project: { number: 1, tags: 1, suggested: { title: 1, views: 1 } } },
    ],
    { cursor: { batchSize: 100 }, comment: "report:suggested-articles" },
  )
  .toArray();

reporting.tickets
  .find({ orgId: bigOrg, createdAt: { $gte: new Date(anchor - 180 * day) } })
  .sort({ "requester.email": 1, createdAt: -1 })
  .allowDiskUse()
  .comment("report:requester-export")
  .toArray();

slaTick();
sleep(5000);

// -- Steady afternoon traffic ---------------------------------------------

for (let round = 0; round < 3; round++) {
  for (const agentId of agentsOfBigOrg.slice(round * 3, round * 3 + 3)) {
    inbox(bigOrg, agentId);
    sleep(between(300, 1200));
  }
  inbox(midOrg, `agt_${String(between(1, agentCount)).padStart(5, "0")}`);
  dashboard(bigOrg);
  slaTick();
  sleep(between(2000, 5000));
}

// -- Someone opens a shell -------------------------------------------------

shell.tickets.find({ "requester.email": "hugo.lund42@example.org" }).toArray();
shell.tickets.count({ status: "open", priority: "urgent" });
shell.tickets
  .find({ status: "open" })
  .sort({ createdAt: 1 })
  .limit(5)
  .toArray();
shell.ticket_events.countDocuments({ ticketNumber: 123456 });
const numbers = [];
for (let n = 1; n <= 20000; n++) numbers.push(n * 7);
shell.ticket_events.count({ ticketNumber: { $in: numbers } });
sleep(3000);

// The fix for the inbox query lands: an index that covers the assignee.
shell.tickets.createIndex(
  { orgId: 1, assigneeId: 1, status: 1, updatedAt: -1 },
  { name: "inbox_by_assignee" },
);
sleep(2000);

// Inboxes drop out of the log; the rest of the traffic carries on.
for (const agentId of agentsOfBigOrg.slice(0, 6)) {
  inbox(bigOrg, agentId);
  sleep(between(200, 600));
}
dashboard(bigOrg);
recentMentions(bigOrg, "chargeback");
slaTick();

// -- Evening maintenance ---------------------------------------------------

const imported = [];
for (let i = 0; i < 15000; i++) {
  imported.push({
    orgId: midOrg,
    ticketNumber: between(1, ticketCount),
    type: "comment",
    actorId: "agt_00002",
    at: new Date(anchor - between(0, 30) * day),
    body: `Imported from the legacy mailbox: ${pick(subjectPool).toLowerCase()}.`,
  });
}
supportWeb.ticket_events.insertMany(imported, { ordered: false });

shell.tickets.updateMany(
  {
    orgId: bigOrg,
    status: "closed",
    updatedAt: { $lt: new Date(anchor - 300 * day) },
  },
  { $addToSet: { tags: "archived" } },
);
shell.tickets.deleteMany({
  orgId: midOrg,
  status: "closed",
  updatedAt: { $lt: new Date(anchor - 340 * day) },
});
shell.tickets.bulkWrite([
  {
    updateMany: {
      filter: { orgId: bigOrg, "sla.dueAt": { $lt: now }, status: "open" },
      update: { $set: { "sla.breached": true } },
    },
  },
  {
    deleteMany: { filter: { orgId: "org_0777", status: "closed" } },
  },
]);
slaTick();
sleep(2000);
reporting.ticket_events
  .aggregate(
    [
      { $match: { orgId: bigOrg, at: { $gte: new Date(anchor - 7 * day) } } },
      { $sort: { at: -1 } },
      { $project: { ticketNumber: 1, type: 1, actorId: 1, at: 1 } },
    ],
    { cursor: { batchSize: 5000 }, comment: "export:activity-feed" },
  )
  .toArray();
slaTick();

print("workload complete");
