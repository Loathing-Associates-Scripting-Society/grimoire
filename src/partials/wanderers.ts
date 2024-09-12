import { adv1 } from "kolmafia";
import { $item, get, have } from "libram";
import { Task } from "../task";

export const ProtonGhost: Task = {
  name: "Proton Ghost",
  ready: () => {
    const location = get("ghostLocation");
    if (location) {
      return (
        have($item`protonic accelerator pack`) &&
        get("questPAGhost") !== "unstarted" &&
        !!get("ghostLocation")
      );
    }
    return false;
  },
  completed: () => get("questPAGhost") === "unstarted",
  do: (): void => {
    const location = get("ghostLocation");
    if (location) {
      adv1(location, 0, "");
    } else {
      throw "Could not determine Proton Ghost location!";
    }
  },
};

export const VoidMonster: Omit<Task, "do"> = {
  name: "Void Monster",
  ready: () => have($item`cursed magnifying glass`) && get("cursedMagnifyingGlassCount") === 13,
  completed: () => get("_voidFreeFights") >= 5,
  outfit: { offhand: $item`cursed magnifying glass` },
};
