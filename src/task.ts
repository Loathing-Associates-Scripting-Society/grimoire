import { Effect, Item, Location } from "kolmafia";
import { Delayed, get } from "libram";
import { StringProperty } from "libram/dist/propertyTypes";
import { CombatStrategy } from "./combat";
import { Limit } from "./limit";
import { Outfit, OutfitSpec } from "./outfit";

export type Quest<T> = {
  name: string;
  completed?: () => boolean;
  ready?: () => boolean;
  tasks: T[];
};

export type AcquireItem = {
  item: Item;
  num?: number;
  price?: number;
  useful?: () => boolean;
  optional?: boolean;
  get?: () => void;
};

export const TaskRequiredProperties = ["completed", "do", "name"] as const;

export type Task<A extends string = never> = {
  name: string;
  after?: string[];

  ready?: () => boolean;
  completed: () => boolean;

  // How to perform the task
  // Executed as:
  //  1. prepare();
  //  2. adv1(do) OR do();
  //  3. post();
  prepare?: () => void;
  do: Location | (() => Location) | (() => void);
  post?: () => void;

  acquire?: Delayed<AcquireItem[]>;
  effects?: Delayed<Effect[]>;
  choices?: Delayed<{ [id: number]: number | string }>;
  limit?: Limit;
  outfit?: Delayed<OutfitSpec | Outfit>;
  combat?: CombatStrategy<A>;
};

export type StrictCombatTask<
  A extends string = never,
  C extends CombatStrategy<A> = CombatStrategy<A>,
  O extends OutfitSpec | Outfit = OutfitSpec | Outfit,
> = Omit<Task, "do" | "combat" | "outfit"> &
  (
    | {
        do: Delayed<Location> | (() => void);
        combat: C;
        outfit: Delayed<O>;
      }
    | { do: () => void; outfit?: Delayed<O> }
  );

/**
 * Returns the state of a quest as a numeric value as follows:
 *   "unstarted" => -1
 *   "started" => 0
 *   "stepNUM" => NUM
 *   "finished" => 999
 */
export function step(questName: StringProperty): number {
  const stringStep = get(questName);
  if (stringStep === "unstarted") return -1;
  else if (stringStep === "started") return 0;
  else if (stringStep === "finished") return 999;
  else {
    if (stringStep.substring(0, 4) !== "step") {
      throw "Quest state parsing error.";
    }
    return parseInt(stringStep.substring(4), 10);
  }
}
