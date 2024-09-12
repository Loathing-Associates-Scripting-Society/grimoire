import { Outfit } from "../outfit";
import { Task, TaskRequiredProperties } from "../task";

class TaskPartialError extends Error {}

function validate<Z extends string>(task: Partial<Task<Z>>): Task {
  const missing = TaskRequiredProperties.filter((p) => task[p] === undefined);
  if (missing.length > 0) {
    throw new TaskPartialError(`Missing properties on task: ${missing.join(",")}`);
  }
  return task as Task;
}

function combinef<Z extends string>(
  a: Partial<Task<Z>>,
  b: Partial<Task<Z>>,
  c: "prepare" | "post"
): () => void {
  const afun = a[c] ?? (() => true);
  const bfun = b[c] ?? (() => true);
  return () => {
    afun();
    bfun();
  };
}

export function extend<T extends Partial<Task<Z>>, S extends keyof T, Z extends string>(
  base: T,
  options: Omit<Task, S> & Partial<Pick<T, S>>
): Task<Z> {
  const opt = options as Partial<Task<Z>>;
  const merge: Partial<Task<Z>>[] = [
    {
      name: opt.name ?? base.name,
      completed: () => (opt.completed ?? (() => false))() || (base.completed ?? (() => false))(),
    },
  ];
  if (typeof opt.do === "function" && typeof base.do === "function") {
    const a = opt.do;
    const b = base.do;
    merge.push({
      do: () => {
        a();
        b();
      },
    });
  } else {
    merge.push({
      do: opt.do ?? base.do,
    });
  }
  if ("ready" in opt || "ready" in base) {
    merge.push({
      ready: () =>
        (typeof opt.ready === "function" ? opt.ready() : opt.ready ?? true) &&
        (typeof base.ready === "function" ? base.ready() : base.ready ?? true),
    });
  }
  if ("prepare" in opt || "prepare" in base) {
    merge.push({
      prepare: combinef(opt, base, "prepare"),
    });
  }
  if ("post" in opt || "post" in base) {
    merge.push({
      prepare: combinef(opt, base, "post"),
    });
  }
  if ("acquire" in opt || "acquire" in base) {
    merge.push({
      acquire: () => [
        ...(typeof opt.acquire === "function" ? opt.acquire() : [...(opt.acquire ?? [])]),
        ...(typeof base.acquire === "function" ? base.acquire() : [...(base.acquire ?? [])]),
      ],
    });
  }
  if ("effects" in opt || "effects" in base) {
    merge.push({
      effects: () => [
        ...(typeof opt.effects === "function" ? opt.effects() : [...(opt.effects ?? [])]),
        ...(typeof base.effects === "function" ? base.effects() : [...(base.effects ?? [])]),
      ],
    });
  }
  if ("choices" in opt || "choices" in base) {
    merge.push({
      choices: { ...(base.choices ?? {}), ...(opt.choices ?? {}) },
    });
  }
  if ("limit" in opt || "limit" in base) {
    merge.push({
      limit: { ...(base.limit ?? {}), ...(opt.limit ?? {}) },
    });
  }
  if ("outfit" in opt || "outfit" in base) {
    const afun =
      typeof opt.outfit === "function"
        ? opt.outfit
        : () => (opt.outfit instanceof Outfit ? opt.outfit.spec() : opt.outfit ?? {});
    const bfun =
      typeof base.outfit === "function"
        ? base.outfit
        : () => (base.outfit instanceof Outfit ? base.outfit.spec() : base.outfit ?? {});
    merge.push({
      outfit: () => {
        return {
          ...afun(),
          ...bfun(),
        };
      },
    });
  }
  if ("combat" in opt || "combat" in base) {
    const task: Partial<Task<Z>> = {
      combat: opt.combat ?? base.combat,
    };
    merge.push(task);
  }
  return validate(
    merge.reduce((p, a) => {
      return { ...a, ...p };
    })
  );
}

export function override(base: Partial<Task>, options: Partial<Task>): Task {
  return validate({ ...base, ...options });
}