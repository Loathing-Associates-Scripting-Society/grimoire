import { Task } from "./task";
import {
  $location,
  $locations,
  $skill,
  ensureEffect,
  get,
  have,
  isSong,
  KnownProperty,
  PropertiesManager,
  set,
  undelay,
  uneffect,
} from "libram";
import {
  adv1,
  buy,
  choiceFollowsFight,
  cliExecute,
  Effect,
  equippedAmount,
  getRelated,
  inMultiFight,
  itemAmount,
  Location,
  logprint,
  myEffects,
  print,
  readCcs,
  retrieveItem,
  runChoice,
  runCombat,
  setAutoAttack,
  setLocation,
  toEffect,
  writeCcs,
} from "kolmafia";
import { Outfit } from "./outfit";
import { ActionDefaults, CombatResources, CombatStrategy } from "./combat";

type Optional<T> = { [x in keyof T]-?: undefined extends T[x] ? NonNullable<T[x]> : never };
export class EngineOptions<A extends string = never, T extends Task<A> = Task<A>> {
  combat_defaults?: ActionDefaults<A>;
  ccs?: string; // If given, use a custom ccs instead of the Grimoire auto-generated ccs
  allow_partial_outfits?: boolean; // If given, do not crash when a specified outfit cannot be fully equipped
  default_task_options?: Partial<Optional<T>>;
}

const grimoireCCS = "grimoire_macro";

export class Engine<A extends string = never, T extends Task<A> = Task<A>> {
  tasks: T[];
  options: EngineOptions<A, T>;
  attempts: { [task_name: string]: number } = {};
  propertyManager = new PropertiesManager();
  tasks_by_name = new Map<string, T>();
  cachedCcsContents = "";

  /**
   * Create the engine.
   * @param tasks A list of tasks for looking up task dependencies.
   * @param options Basic configuration of the engine.
   */
  constructor(tasks: T[], options?: EngineOptions<A, T>) {
    this.options = options ?? {};
    this.tasks = tasks.map((task) => ({ ...this.options.default_task_options, ...task }));
    for (const task of this.tasks) {
      this.tasks_by_name.set(task.name, task);
    }
    this.initPropertiesManager(this.propertyManager);
  }

  /**
   * Determine the next task to perform.
   * By default, this is the first task in the task list that is available.
   * @returns The next task to perform, or undefined if no tasks are available.
   */
  public getNextTask(): T | undefined {
    return this.tasks.find((task) => this.available(task));
  }

  /**
   * Continually get the next task and execute it.
   * @param actions If given, only perform up to this many tasks.
   */
  public run(actions?: number): void {
    for (let i = 0; i < (actions ?? Infinity); i++) {
      const task = this.getNextTask();
      if (!task) return;
      this.execute(task);
    }
  }

  /**
   * Close the engine and reset all properties.
   * After this has been called, this object should not be used.
   */
  public destruct(): void {
    this.propertyManager.resetAll();
    setAutoAttack(0);
  }

  /**
   * Check if the given task is available at this moment.
   * @returns true if all dependencies are complete and the task is ready.
   *  Note that dependencies are not checked transitively. That is, if
   *  A depends on B which depends on C, then A is ready if B is complete
   *  (regardless of if C is complete or not).
   */
  public available(task: T): boolean {
    if (task.limit?.skip !== undefined && this.attempts[task.name] >= task.limit.skip) return false;
    for (const after of task.after ?? []) {
      const after_task = this.tasks_by_name.get(after);
      if (after_task === undefined) throw `Unknown task dependency ${after} on ${task.name}`;
      if (!after_task.completed()) return false;
    }
    if (task.ready && !task.ready()) return false;
    if (task.completed()) return false;
    return true;
  }

  /**
   * Perform all steps to execute the provided task.
   * This is the main entry point for the Engine.
   * @param task The current executing task.
   */
  public execute(task: T): void {
    print(``);
    print(`Executing ${task.name}`, "blue");

    // Determine the proper postcondition for after the task executes.
    const postcondition = task.limit?.guard?.();

    // Acquire any items and effects first, possibly for later execution steps.
    this.acquireItems(task);
    this.acquireEffects(task);

    // Prepare the outfit, with resources.
    const task_combat = task.combat?.clone() ?? new CombatStrategy<A>();
    const outfit = this.createOutfit(task);

    const task_resources = new CombatResources<A>();
    // Create the task properly
    this.customize(task, outfit, task_combat, task_resources);

    // Do all preparation actions
    for (const resource of task_resources.all()) resource.prepare?.();
    this.prepare(task);

    this.dress(task, outfit);

    // Prepare combat and choices
    this.setCombat(task, task_combat, task_resources);
    this.setChoices(task, this.propertyManager);

    // Actually perform the task
    this.do(task);
    while (this.shouldRepeatAdv(task)) {
      set("lastEncounter", "");
      this.do(task);
    }
    this.post(task);

    // Mark that we tried the task, and apply limits
    this.markAttempt(task);
    this.checkLimits(task, postcondition);
  }

  /**
   * Acquire all items for the task.
   * @param task The current executing task.
   */
  acquireItems(task: T): void {
    const acquire = undelay(task.acquire);
    for (const to_get of acquire || []) {
      const num_needed = to_get.num ?? 1;
      const num_have = itemAmount(to_get.item) + equippedAmount(to_get.item);
      if (num_needed <= num_have) continue;
      if (to_get.useful !== undefined && !to_get.useful()) continue;
      if (to_get.get) {
        to_get.get();
      } else if (to_get.price !== undefined) {
        buy(to_get.item, num_needed - num_have, to_get.price);
      } else if (Object.keys(getRelated(to_get.item, "fold")).length > 0) {
        cliExecute(`fold ${to_get.item}`);
      } else {
        retrieveItem(to_get.item, num_needed);
      }
      if (itemAmount(to_get.item) + equippedAmount(to_get.item) < num_needed && !to_get.optional) {
        throw `Task ${task.name} was unable to acquire ${num_needed} ${to_get.item}`;
      }
    }
  }

  /**
   * Acquire all effects for the task.
   * @param task The current executing task.
   */
  acquireEffects(task: T): void {
    const effects: Effect[] = undelay(task.effects) ?? [];
    const songs = effects.filter((effect) => isSong(effect));
    if (songs.length > maxSongs()) throw "Too many AT songs";
    const extraSongs = Object.keys(myEffects())
      .map((effectName) => toEffect(effectName))
      .filter((effect) => isSong(effect) && !songs.includes(effect));
    while (songs.length + extraSongs.length > maxSongs()) {
      const toRemove = extraSongs.pop();
      if (toRemove === undefined) {
        break;
      } else {
        uneffect(toRemove);
      }
    }

    for (const effect of effects) ensureEffect(effect);
  }

  /**
   * Create an outfit for the task with all required equipment.
   * @param task The current executing task.
   */
  createOutfit(task: T): Outfit {
    const spec = undelay(task.outfit);
    if (spec instanceof Outfit) return spec.clone();

    const outfit = new Outfit();
    if (spec !== undefined) {
      if (!outfit.equip(spec) && !this.options.allow_partial_outfits) {
        throw `Unable to equip all items for ${task.name}`;
      }
    }
    return outfit;
  }

  /**
   * Equip the outfit for the task.
   * @param task The current executing task.
   * @param outfit The outfit for the task, possibly augmented by the engine.
   */
  dress(task: T, outfit: Outfit): void {
    if (task.do instanceof Location) setLocation(task.do);
    outfit.dress();
  }

  /* eslint-disable @typescript-eslint/no-unused-vars */
  /**
   * Perform any engine-specific customization for the outfit and combat plan.
   *
   * This is a natural method to override in order to:
   *   * Enable the use of any resources in the outfit or combat (e.g., allocate banishers).
   *   * Equip a default outfit.
   *   * Determine additional monster macros at a global level (e.g., use flyers).
   * @param task The current executing task.
   * @param outfit The outfit for the task.
   * @param combat The combat strategy so far for the task.
   * @param resources The combat resources assigned so far for the task.
   */
  customize(
    task: T,
    outfit: Outfit,
    combat: CombatStrategy<A>,
    resources: CombatResources<A>,
  ): void {
    // do nothing by default
  }
  /* eslint-enable @typescript-eslint/no-unused-vars */

  /**
   * Set the choice settings for the task.
   * @param task The current executing task.
   * @param manager The property manager to use.
   */
  setChoices(task: T, manager: PropertiesManager): void {
    for (const [key, value] of Object.entries(undelay(task.choices ?? {}))) {
      if (value === undefined) continue;
      manager.setChoice(parseInt(key), value);
    }
  }

  /**
   * Save the combat macro for this task.
   * @param task The current executing task.
   * @param task_combat The completed combat strategy far for the task.
   * @param task_resources The combat resources assigned for the task.
   */
  setCombat(task: T, task_combat: CombatStrategy<A>, task_resources: CombatResources<A>): void {
    // Save regular combat macro
    const macro = task_combat.compile(
      task_resources,
      this.options?.combat_defaults,
      task.do instanceof Location ? task.do : undefined,
    );
    macro.save();
    if (!this.options.ccs) {
      // Use the macro through a CCS file
      const otherCCSEntries = task_combat.compileCcs();
      const ccsContents = ["[default]", `"${macro.toString()}"`, ...otherCCSEntries].join("\n");

      // Log Macro + other CCS
      logprint(`CCS: ${ccsContents.replace("\n", "\\n ")}`);

      if (ccsContents !== this.cachedCcsContents) {
        writeCcs(ccsContents, grimoireCCS);
        cliExecute(`ccs ${grimoireCCS}`); // force Mafia to reparse the ccs
        this.cachedCcsContents = ccsContents;
      }
    }

    // Save autoattack combat macro
    const autoattack = task_combat.compileAutoattack();
    if (autoattack.toString().length > 1) {
      logprint(`Autoattack macro: ${autoattack.toString()}`);
      autoattack.setAutoAttack();
    } else {
      setAutoAttack(0);
    }
  }

  /**
   * Do any task-specific preparation.
   * @param task The current executing task.
   */
  prepare(task: T): void {
    task.prepare?.();
  }

  /**
   * Actually perform the task.
   * @param task The current executing task.
   */
  do(task: T): void {
    const result = typeof task.do === "function" ? task.do() : task.do;
    if (result instanceof Location) adv1(result, -1, "");
    runCombat();
    while (inMultiFight()) runCombat();
    if (choiceFollowsFight()) runChoice(-1);
  }

  /**
   * Check if the task.do should be immediately repeated without any prep.
   *
   * By default, this is only used to repeat a task if we hit one of:
   *   1. Halloweener dog noncombats,
   *   2. June cleaver noncombats,
   *   3. Lil' Doctor™ bag noncombat, or
   *   4. Turtle taming noncombats.
   * @param task The current executing task.
   * @returns True if the task should be immediately repeated.
   */
  shouldRepeatAdv(task: T): boolean {
    return task.do instanceof Location && lastEncounterWasWanderingNC();
  }

  /**
   * Do any task-specific wrapup activities.
   * @param task The current executing task.
   */
  post(task: T): void {
    task.post?.();
  }

  /**
   * Mark that an attempt was made on the current task.
   * @param task The current executing task.
   */
  markAttempt(task: T): void {
    if (!(task.name in this.attempts)) this.attempts[task.name] = 0;
    this.attempts[task.name]++;
  }

  /**
   * Check if the task has passed any of its internal limits.
   * @param task The task to check.
   * @throws An error if any of the internal limits have been passed.
   */
  checkLimits(task: T, postcondition: (() => boolean) | undefined): void {
    if (!task.limit) return;
    const failureMessage = task.limit.message ? ` ${task.limit.message}` : "";
    if (!task.completed()) {
      if (task.limit.tries && this.attempts[task.name] >= task.limit.tries)
        throw `Task ${task.name} did not complete within ${task.limit.tries} attempts. Please check what went wrong.${failureMessage}`;
      if (task.limit.soft && this.attempts[task.name] >= task.limit.soft)
        throw `Task ${task.name} did not complete within ${task.limit.soft} attempts. Please check what went wrong (you may just be unlucky).${failureMessage}`;
      if (task.limit.turns && task.do instanceof Location && task.do.turnsSpent >= task.limit.turns)
        throw `Task ${task.name} did not complete within ${task.limit.turns} turns. Please check what went wrong.${failureMessage}`;
      if (task.limit.unready && task.ready?.())
        throw `Task ${task.name} is still ready, but it should not be. Please check what went wrong.${failureMessage}`;
      if (task.limit.completed)
        throw `Task ${task.name} is not completed, but it should be. Please check what went wrong.${failureMessage}`;
    }
    if (postcondition && !postcondition()) {
      throw `Task ${task.name} failed its guard. Please check what went wrong.${failureMessage}`;
    }
  }

  static defaultSettings = {
    logPreferenceChange: true,
    logPreferenceChangeFilter: [
      ...new Set([
        ...get("logPreferenceChangeFilter").split(","),
        "libram_savedMacro",
        "maximizerMRUList",
        "testudinalTeachings",
        "_lastCombatStarted",
      ]),
    ]
      .sort()
      .filter((a) => a)
      .join(","),
    battleAction: "custom combat script",
    autoSatisfyWithMall: true,
    autoSatisfyWithNPCs: true,
    autoSatisfyWithCoinmasters: true,
    autoSatisfyWithStash: false,
    dontStopForCounters: true,
    maximizerFoldables: true,
    hpAutoRecovery: "-0.05",
    hpAutoRecoveryTarget: "0.0",
    mpAutoRecovery: "-0.05",
    mpAutoRecoveryTarget: "0.0",
    afterAdventureScript: "",
    betweenBattleScript: "",
    choiceAdventureScript: "",
    familiarScript: "",
    currentMood: "apathetic",
    autoTuxedo: true,
    autoPinkyRing: true,
    autoGarish: true,
    allowNonMoodBurning: false,
    allowSummonBurning: true,
    libramSkillsSoftcore: "none",
  };

  private getDefaultSettings(): { [x in KnownProperty]: unknown } {
    return (this.constructor as unknown as { defaultSettings: { [x in KnownProperty]: unknown } })
      .defaultSettings;
  }

  /**
   * Initialize properties for the script.
   * @param manager The properties manager to use.
   */
  initPropertiesManager(manager: PropertiesManager): void {
    // Properties adapted from garbo
    manager.set(this.getDefaultSettings());
    if (this.options.ccs !== "") {
      if (this.options.ccs === undefined && readCcs(grimoireCCS) === "") {
        // Write a simple CCS so we can switch to it
        writeCcs("[ default ]\nabort", grimoireCCS);
      }
      manager.set({ customCombatScript: this.options.ccs ?? grimoireCCS });
    }
  }
}

export function maxSongs(): number {
  return have($skill`Mariachi Memory`) ? 4 : 3;
}

export const wanderingNCs = new Set<string>([
  // Halloweener dog noncombats
  "Wooof! Wooooooof!",
  "Playing Fetch*",
  // June cleaver noncombats
  "Aunts not Ants",
  "Bath Time",
  "Beware of Aligator",
  "Delicious Sprouts",
  "Hypnotic Master",
  "Lost and Found",
  "Poetic Justice",
  "Summer Days",
  "Teacher's Pet",
  // Lil' Doctor™ bag noncombat
  "A Pound of Cure",
  // Turtle taming noncombats
  "Nantucket Snapper",
  "Blue Monday",
  "Capital!",
  "Training Day",
  "Boxed In",
  "Duel Nature",
  "Slow Food",
  "A Rolling Turtle Gathers No Moss",
  "Slow Road to Hell",
  "C'mere, Little Fella",
  "The Real Victims",
  "Like That Time in Tortuga",
  "Cleansing your Palette",
  "Harem Scarum",
  "Turtle in peril",
  "No Man, No Hole",
  "Slow and Steady Wins the Brawl",
  "Stormy Weather",
  "Turtles of the Universe",
  "O Turtle Were Art Thou",
  "Allow 6-8 Weeks For Delivery",
  "Kick the Can",
  "Turtles All The Way Around",
  "More eXtreme Than Usual",
  "Jewel in the Rough",
  "The worst kind of drowning",
  "Even Tamer Than Usual",
  "Never Break the Chain",
  "Close, but Yes Cigar",
  "Armchair Quarterback",
  "This Turtle Rocks!",
  "Really Sticking Her Neck Out",
  "It Came from Beneath the Sewer? Great!",
  "Don't Be Alarmed, Now",
  "Puttin' it on Wax",
  "More Like... Hurtle",
  "Musk! Musk! Musk!",
  "Silent Strolling",
]);

export const zoneSpecificNCs = new Map<string, Location[]>([
  ["The Horror...", $locations`Frat House`], // Duplicate choice name
]);

/**
 * Return true if the last adv was one of:
 *   1. Halloweener dog noncombats,
 *   2. June cleaver noncombats,
 *   3. Lil' Doctor™ bag noncombat, or
 *   4. Turtle taming noncombats.
 */
export function lastEncounterWasWanderingNC(): boolean {
  const last = get("lastEncounter");
  if (zoneSpecificNCs.has(last)) {
    // Handle NCs with a duplicated name
    const zones = zoneSpecificNCs.get(last) ?? [];
    return zones.includes(get("lastAdventure") ?? $location.none);
  } else {
    return wanderingNCs.has(last);
  }
}
