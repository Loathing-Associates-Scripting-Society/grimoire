import { $item, $skill, AsdonMartin, get, have, Macro } from "libram";
import { Task } from "../task";

export type FreeRun = { macro: Macro }; 
export const BowlingBall: Omit<Task, "do"> & FreeRun = {
  name: "Bowling Ball Run",
  ready: () => get("cosmicBowlingBallReturnCombats") < 1 && get("hasCosmicBowlingBall"),
  completed: () => false,
  macro: Macro.trySkill($skill`Bowl a Curveball`),
};

export const AsdonBumper: Omit<Task, "do"> & FreeRun = {
  name: "Asdon Bumper",
  ready: () => AsdonMartin.installed(),
  completed: () => get("banishedMonsters").includes("Spring-Loaded Front Bumper"),
  macro: Macro.skill($skill`Asdon Martin: Spring-Loaded Front Bumper`),
  prepare: () => AsdonMartin.fillTo(50),
};

export const Scrapbook: Omit<Task, "do"> & FreeRun = {
  name: "Familiar Scrapbook",
  ready: () => have($item`familiar scrapbook`) && get("scrapbookCharges") > 40,
  completed: () => get("scrapbookCharges") < 40,
  macro: Macro.skill($skill`Show Your Boring Familiar Pictures`),
}