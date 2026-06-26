/**
 * backgroundTaskQueue.js
 *
 * Defines a TaskQueue interface and provides a default MemoryQueue implementation.
 * All Plugin Manager operations depend on the TaskQueue abstraction only —
 * never directly on MemoryQueue — so the backing implementation can be swapped
 * for BullMQ, Redis, RabbitMQ, or a database-backed queue without touching
 * Plugin Manager business logic.
 *
 * MemoryQueue features:
 *   - Bounded concurrency per instance (default: 2 concurrent tasks)
 *   - Task status tracking (queued → running → completed / failed)
 *   - WebSocket progress broadcast via an optional onProgress hook
 */

const { v4: uuidv4 } = require("uuid");
const log = new (require("cat-loggr"))();

// ─── Interface ────────────────────────────────────────────────────────────────
class TaskQueue {
  /** Enqueue an async work function and return a taskId. */
  async enqueue(instanceId, work, onProgress) {
    throw new Error("TaskQueue.enqueue() must be implemented");
  }

  /** Return the current status of a task. */
  async status(taskId) {
    throw new Error("TaskQueue.status() must be implemented");
  }
}

// ─── MemoryQueue ──────────────────────────────────────────────────────────────
class MemoryQueue extends TaskQueue {
  constructor({ maxConcurrentPerInstance = 2 } = {}) {
    super();
    this._maxConcurrent = maxConcurrentPerInstance;
    this._tasks  = new Map(); // taskId → TaskRecord
    this._queues = new Map(); // instanceId → Queue<TaskRecord>
    this._active = new Map(); // instanceId → number of running tasks
  }

  async enqueue(instanceId, work, onProgress = () => {}) {
    const taskId = uuidv4();
    const record = {
      taskId,
      instanceId,
      status: "queued",
      createdAt: Date.now(),
      startedAt: null,
      completedAt: null,
      error: null,
      work,
      onProgress,
    };

    this._tasks.set(taskId, record);

    if (!this._queues.has(instanceId)) this._queues.set(instanceId, []);
    this._queues.get(instanceId).push(record);

    // Try to start processing immediately
    setImmediate(() => this._drain(instanceId));

    return taskId;
  }

  async status(taskId) {
    const record = this._tasks.get(taskId);
    if (!record) return null;
    return {
      taskId:      record.taskId,
      status:      record.status,
      createdAt:   record.createdAt,
      startedAt:   record.startedAt,
      completedAt: record.completedAt,
      error:       record.error,
    };
  }

  _drain(instanceId) {
    const queue  = this._queues.get(instanceId) || [];
    const active = this._active.get(instanceId) || 0;

    if (active >= this._maxConcurrent) return;
    if (queue.length === 0) return;

    const record = queue.shift();
    this._active.set(instanceId, active + 1);

    record.status    = "running";
    record.startedAt = Date.now();

    record.work(record.onProgress)
      .then(() => {
        record.status      = "completed";
        record.completedAt = Date.now();
      })
      .catch(err => {
        log.error(`MemoryQueue task ${record.taskId} failed: ${err.message}`);
        record.status      = "failed";
        record.error       = err.message;
        record.completedAt = Date.now();
      })
      .finally(() => {
        this._active.set(instanceId, (this._active.get(instanceId) || 1) - 1);
        // Drain the next item
        setImmediate(() => this._drain(instanceId));
      });
  }
}

// ─── Singleton (default MemoryQueue) ─────────────────────────────────────────
const defaultQueue = new MemoryQueue({ maxConcurrentPerInstance: 2 });

module.exports = { TaskQueue, MemoryQueue, queue: defaultQueue };
