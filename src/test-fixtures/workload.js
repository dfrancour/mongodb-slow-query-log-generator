// @ts-nocheck — mongosh script; `db` and `print` are shell globals.
/* global db, print */
// Workload that exercises the operation types and plan shapes the
// Slow Query Explorer must handle. Run with mongosh against a mongod
// started with --slowms 0 so every operation is logged as "Slow query".
//
// Data is synthetic. Field names are chosen to look like a realistic
// application (orders, customers, events) without any real records.

const dbName = "shopdb";
const app = db.getSiblingDB(dbName);
app.dropDatabase();

const orders = app.orders;
const customers = app.customers;
const events = app.events;

const statuses = ["pending", "paid", "shipped", "cancelled", "refunded"];
const regions = ["us-east", "us-west", "eu-central", "ap-south"];
const start = new Date("2026-01-01T00:00:00Z").getTime();

function bulk(coll, count, make) {
  const batch = [];
  for (let i = 0; i < count; i++) {
    batch.push(make(i));
    if (batch.length === 1000) {
      coll.insertMany(batch);
      batch.length = 0;
    }
  }
  if (batch.length) coll.insertMany(batch);
}

bulk(customers, 5000, (i) => ({
  _id: i,
  email: `user${i}@example.test`,
  region: regions[i % regions.length],
  tier: i % 10 === 0 ? "gold" : "standard",
  createdAt: new Date(start + i * 60000),
}));

bulk(orders, 60000, (i) => ({
  customerId: i % 5000,
  status: statuses[i % statuses.length],
  region: regions[(i * 7) % regions.length],
  total: (i * 37) % 500,
  items: [{ sku: `SKU-${i % 300}`, qty: (i % 5) + 1 }],
  createdAt: new Date(start + i * 5000),
  tags: i % 3 === 0 ? ["gift"] : [],
}));

bulk(events, 30000, (i) => ({
  type: i % 4 === 0 ? "click" : "view",
  customerId: i % 5000,
  at: new Date(start + i * 3000),
  payload: { page: `/p/${i % 100}` },
}));

orders.createIndex({ customerId: 1, createdAt: -1 });
orders.createIndex({ status: 1, region: 1 });
customers.createIndex({ email: 1 }, { unique: true });
events.createIndex({ at: 1 });

// --- Reads: indexed, unindexed, sorted, covered -------------------------

orders.find({ customerId: 42 }).sort({ createdAt: -1 }).limit(20).toArray();
orders.find({ status: "paid", region: "eu-central" }).limit(50).toArray();
orders.find({ total: { $gt: 480 } }).toArray(); // COLLSCAN
orders.find({ status: "shipped" }).sort({ total: -1 }).limit(10).toArray(); // in-memory sort
orders
  .find(
    { customerId: { $in: [1, 2, 3] } },
    { customerId: 1, createdAt: 1, _id: 0 },
  )
  .toArray(); // covered
customers.findOne({ email: "user77@example.test" });
customers
  .find({ region: "us-east", tier: "gold" })
  .comment("dashboard:gold-customers")
  .toArray();
orders.find({ "items.sku": "SKU-7" }).toArray();
orders
  .find({ tags: "gift", createdAt: { $gte: new Date("2026-01-02T00:00:00Z") } })
  .toArray();
orders.find({ $or: [{ status: "refunded" }, { total: 0 }] }).toArray();
orders.find({ $expr: { $gt: ["$total", 490] } }).toArray();
orders.find({ region: /^eu/ }).limit(5).toArray();

// Same shape, different values, several times (for shape grouping tests).
for (const id of [7, 99, 1234, 4999]) {
  orders.find({ customerId: id }).sort({ createdAt: -1 }).limit(20).toArray();
}

// --- Cursor batches (getMore) ------------------------------------------

orders.find({ status: "pending" }).batchSize(500).toArray();
orders
  .aggregate(
    [{ $match: { status: "paid" } }, { $project: { total: 1, region: 1 } }],
    {
      cursor: { batchSize: 200 },
    },
  )
  .toArray();

// --- Aggregations -------------------------------------------------------

orders
  .aggregate([
    { $match: { status: "paid" } },
    { $group: { _id: "$region", revenue: { $sum: "$total" }, n: { $sum: 1 } } },
    { $sort: { revenue: -1 } },
  ])
  .toArray();

orders
  .aggregate([
    { $match: { customerId: { $lt: 50 } } },
    {
      $lookup: {
        from: "customers",
        localField: "customerId",
        foreignField: "_id",
        as: "customer",
      },
    },
    { $unwind: "$customer" },
    { $project: { total: 1, email: "$customer.email" } },
  ])
  .toArray();

events
  .aggregate([
    { $match: { at: { $gte: new Date("2026-01-01T00:00:00Z") } } },
    {
      $group: {
        _id: { $dateTrunc: { date: "$at", unit: "hour" } },
        n: { $sum: 1 },
      },
    },
    { $sort: { _id: 1 } },
  ])
  .toArray();

orders
  .aggregate([{ $sort: { total: -1, createdAt: 1 } }, { $limit: 5 }], {
    allowDiskUse: true,
  })
  .toArray();

orders
  .aggregate([
    { $match: { status: "paid" } },
    {
      $facet: {
        byRegion: [{ $sortByCount: "$region" }],
        top: [{ $sort: { total: -1 } }, { $limit: 3 }],
      },
    },
  ])
  .toArray();

orders
  .aggregate(
    [{ $match: { $expr: { $eq: ["$status", "cancelled"] } } }, { $count: "n" }],
    {
      comment: "report:cancellations",
    },
  )
  .toArray();

// --- Counts and distinct -----------------------------------------------

orders.countDocuments({ status: "paid" });
orders.countDocuments({ total: { $lt: 10 } });
orders.estimatedDocumentCount();
orders.distinct("region", { status: "shipped" });
customers.distinct("tier");

// --- Writes -------------------------------------------------------------

orders.updateOne(
  { customerId: 42, status: "pending" },
  { $set: { status: "paid" } },
);
orders.updateMany(
  { status: "cancelled", total: { $lt: 5 } },
  { $set: { status: "refunded" } },
);
orders.updateMany({ region: "ap-south" }, { $inc: { total: 1 } }); // wide update
orders.findOneAndUpdate(
  { customerId: 7 },
  { $set: { flagged: true } },
  { returnDocument: "after" },
);
orders.findOneAndDelete({ customerId: 4999 });
orders.deleteMany({ status: "refunded", total: 0 });
orders.insertOne({
  customerId: 1,
  status: "pending",
  region: "us-east",
  total: 12,
  items: [],
  createdAt: new Date(),
});
customers.insertMany([
  {
    _id: 90001,
    email: "new1@example.test",
    region: "us-west",
    tier: "standard",
  },
]);
orders.bulkWrite([
  {
    updateOne: { filter: { customerId: 2 }, update: { $set: { note: "vip" } } },
  },
  { deleteOne: { filter: { customerId: 3, status: "cancelled" } } },
]);

// --- Truncated command (large $in) -------------------------------------

const bigIn = [];
for (let i = 0; i < 20000; i++) bigIn.push(i);
orders
  .find({ customerId: { $in: bigIn } })
  .limit(1)
  .toArray();

// --- Replan trigger: same shape, very different selectivity -------------

for (let i = 0; i < 30; i++)
  orders.find({ status: "paid", region: "eu-central" }).limit(1).toArray();
orders.find({ status: "nonexistent", region: "eu-central" }).limit(1).toArray();

print("workload complete");
