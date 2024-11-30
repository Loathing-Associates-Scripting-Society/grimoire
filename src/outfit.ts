import {
  bjornifyFamiliar,
  booleanModifier,
  canEquip,
  cliExecute,
  enthroneFamiliar,
  equip,
  equippedItem,
  Familiar,
  haveEquipped,
  Item,
  logprint,
  equippedAmount as mafiaEquippedAmount,
  weaponHands as mafiaWeaponHands,
  myBjornedFamiliar,
  myEnthronedFamiliar,
  myFamiliar,
  Slot,
  toSlot,
  useFamiliar,
} from "kolmafia";
import {
  $familiar,
  $item,
  $skill,
  $slot,
  $slots,
  applyModes,
  get,
  have,
  Modes as LibramModes,
  Requirement,
} from "libram";

const FORCE_REFRESH_REQUIREMENT = new Requirement([], { forceUpdate: true });

export const outfitSlots = [
  "hat",
  "back",
  "weapon",
  "offhand",
  "shirt",
  "pants",
  "acc1",
  "acc2",
  "acc3",
  "famequip",
] as const;

export type OutfitSlot = (typeof outfitSlots)[number];

export type OutfitEquips = Partial<{ [slot in OutfitSlot]: Item | Item[] }>;

export const riderSlots = ["buddy-bjorn", "crown-of-thrones"] as const;

export type RiderSlot = (typeof riderSlots)[number];

export type OutfitRiders = Partial<{ [slot in RiderSlot]: Familiar | Familiar[] }>;

export type Equippable = Item | Familiar | OutfitSpec | Item[] | Outfit;

export interface OutfitSpec extends OutfitEquips {
  equip?: Item[]; // Items to be equipped in any slot
  modes?: Modes; // Modes to set on particular items
  modifier?: string | string[]; // Modifier to maximize
  familiar?: Familiar; // Familiar to use
  avoid?: Item[]; // Items that cause issues and so should not be equipped
  skipDefaults?: boolean; // Do not equip default equipment; fully maximize
  riders?: OutfitRiders; // Familiars to bjornify-enthrone
  bonuses?: Map<Item, number>;
  beforeDress?: (() => void)[];
  afterDress?: (() => void)[];
}

export type Modes = {
  backupcamera?: "ml" | "meat" | "init";
  umbrella?:
    | "broken"
    | "forward-facing"
    | "bucket style"
    | "pitchfork style"
    | "constantly twirling"
    | "cocoon";
  snowsuit?: "eyebrows" | "smirk" | "nose" | "goatee" | "hat";
  edpiece?: "bear" | "owl" | "puma" | "hyena" | "mouse" | "weasel" | "fish";
  retrocape?: [
    "vampire" | "heck" | "robot" | undefined,
    "hold" | "thrill" | "kiss" | "kill" | undefined,
  ]; // Undefined means "don't care"
  parka?: "kachungasaur" | "dilophosaur" | "ghostasaurus" | "spikolodon" | "pterodactyl";
  jillcandle?: "disco" | "ultraviolet" | "reading" | "red";
};

const weaponHands = (i?: Item) => (i ? mafiaWeaponHands(i) : 0);

const modeableCommands = [
  "backupcamera",
  "umbrella",
  "snowsuit",
  "edpiece",
  "retrocape",
  "parka",
  "jillcandle",
] as const;

export type EquipResult =
  | {
      success: true;
    }
  | {
      success: false;
      reason: string;
    };

/**
 * Create an EquipResult indicating failure.
 *
 * @param msg A message to explain the failure.
 */
function fail(msg: string): EquipResult {
  return {
    success: false,
    reason: msg,
  };
}

/**
 * Create an EquipResult indicating success.
 */
function success(): EquipResult {
  return {
    success: true,
  };
}

/**
 * Return success if any of the subcalls are success.
 * Otherwise, merge all the error messages.
 */
function mergeResults(results: EquipResult[]) {
  if (results.find((r) => r.success)) return success();
  const failures = results.filter((r) => !r.success) as { reason: string }[];
  return fail(
    failures
      .filter((r) => r.reason !== "")
      .map((r) => r.reason)
      .join(". ")
  );
}

export class Outfit {
  equips: Map<Slot, Item> = new Map<Slot, Item>();
  riders: Map<Slot, Familiar> = new Map<Slot, Familiar>();
  modes: Modes = {};
  skipDefaults = false;
  familiar?: Familiar;
  modifier: string[] = [];
  avoid: Item[] = [];
  bonuses = new Map<Item, number>();
  private postActions: (() => void)[] = [];
  private preActions: (() => void)[] = [];

  /**
   * Create an outfit from your current player state.
   */
  static current(): Outfit {
    const outfit = new Outfit();

    const familiar = myFamiliar();
    if (outfit.equip(familiar)) {
      throw `Failed to create outfit from current state (expected: familiar ${familiar})`;
    }

    for (const slotName of outfitSlots) {
      const slot =
        new Map([
          ["famequip", $slot`familiar`],
          ["offhand", $slot`off-hand`],
        ]).get(slotName) ?? toSlot(slotName);
      const item = equippedItem(slot);
      if (!outfit.equip(item, slot)) {
        throw `Failed to create outfit from current state (expected: ${slot} ${item})`;
      }
    }

    if (haveEquipped($item`Crown of Thrones`))
      outfit.riders.set($slot`crown-of-thrones`, myEnthronedFamiliar());
    if (haveEquipped($item`Buddy Bjorn`))
      outfit.riders.set($slot`buddy-bjorn`, myBjornedFamiliar());

    outfit.setModes(getCurrentModes());
    return outfit;
  }

  /**
   * Check how many of an item is equipped on the outfit.
   */
  public equippedAmount(item: Item): number {
    return [...this.equips.values()].filter((i) => i === item).length;
  }

  private isAvailable(item: Item): EquipResult {
    if (this.avoid?.includes(item))
      return fail(`Cannot equip ${item} since it is on the avoid list (${this.avoid.join(", ")})`);
    if (!have(item, this.equippedAmount(item) + 1)) {
      if (!have(item)) {
        return fail(`Cannot equip ${item} since you do not have any`);
      } else {
        return fail(
          `Cannot equip ${item} again since you do not have ${this.equippedAmount(item) + 1}`
        );
      }
    }
    if (booleanModifier(item, "Single Equip") && this.equippedAmount(item) > 0)
      return fail(`Cannot equip ${item} again since you already have one equipped`);
    return success();
  }

  /**
   * Check whether an item is equipped on the outfit, optionally in a specific slot.
   */
  public haveEquipped(item: Item, slot?: Slot): boolean {
    if (slot === undefined) return this.equippedAmount(item) > 0;
    return this.equips.get(slot) === item;
  }

  private equipItemNone(item: Item, slot?: Slot): EquipResult {
    if (item !== $item.none) return fail("");
    if (slot === undefined) return success();
    if (this.equips.has(slot))
      return fail(`Cannot equip ${item} to ${slot} since ${this.equips.get(slot)} is equipped`);
    this.equips.set(slot, item);
    return success();
  }

  private equipNonAccessory(item: Item, slot?: Slot): EquipResult {
    if ($slots`acc1, acc2, acc3`.includes(toSlot(item))) return fail("");
    if (slot !== undefined && slot !== toSlot(item))
      return fail(`Cannot equip ${item} to ${slot} since it is ${toSlot(item)}`);
    slot = toSlot(item);
    if (this.equips.has(slot))
      return fail(`Cannot equip ${item} to ${slot} since ${this.equips.get(slot)} is equipped`);
    switch (slot) {
      case $slot`off-hand`:
        if (this.equips.has($slot`weapon`) && weaponHands(this.equips.get($slot`weapon`)) !== 1) {
          return fail(
            `Cannot equip ${item} to ${slot} since the weapon ${this.equips.get(
              $slot`weapon`
            )} is not 1-handed`
          );
        }
        break;
      case $slot`familiar`:
        if (this.familiar !== undefined && !canEquip(this.familiar, item))
          return fail(`Cannot equip ${item} to ${slot} since familiar is ${this.familiar}`);
    }
    if (slot !== $slot`familiar` && !canEquip(item))
      return fail(`Cannot equip ${item} to ${slot} since canEquip returned false`);
    this.equips.set(slot, item);
    return success();
  }

  private equipAccessory(item: Item, slot?: Slot): EquipResult {
    if (![undefined, ...$slots`acc1, acc2, acc3`].includes(slot)) return fail("");
    if (toSlot(item) !== $slot`acc1`) return fail("");
    if (!canEquip(item))
      return fail(`Cannot equip ${item} as accessory since canEquip returned false`);
    if (slot === undefined) {
      // We don't care which of the accessory slots we equip in
      const empty = $slots`acc1, acc2, acc3`.find((s) => !this.equips.has(s));
      if (empty === undefined) {
        const acc_names = $slots`acc1, acc2, acc3`.map((s) => this.equips.get(s)).join(", ");
        return fail(`Cannot equip ${item} as accessory since ${acc_names} are all equipped`);
      }
      this.equips.set(empty, item);
    } else {
      if (this.equips.has(slot)) {
        return fail(`Cannot equip ${item} to ${slot} since ${this.equips.get(slot)} is equipped`);
      }
      this.equips.set(slot, item);
    }
    return success();
  }

  private equipUsingDualWield(item: Item, slot?: Slot): EquipResult {
    if (![undefined, $slot`off-hand`].includes(slot)) return fail("");
    if (toSlot(item) !== $slot`weapon`) return fail("");
    if (this.equips.has($slot`weapon`) && weaponHands(this.equips.get($slot`weapon`)) !== 1) {
      return fail(
        `Cannot dual-wield ${item} since the weapon ${this.equips.get(
          $slot`weapon`
        )} is not 1-handed`
      );
    }
    if (this.equips.has($slot`off-hand`))
      return fail(
        `Cannot dual-wield ${item} since the off-hand ${this.equips.get(
          $slot`off-hand`
        )} is equipped`
      );
    if (!have($skill`Double-Fisted Skull Smashing`))
      return fail(`Cannot dual-wield ${item} since we do not have Double-Fisted Skull Smashing`);
    if (weaponHands(item) !== 1) return fail(`Cannot dual-wield ${item} since it is not 1-handed`);
    if (!canEquip(item)) return fail(`Cannot dual-wield ${item} since canEquip returned false`);
    this.equips.set($slot`off-hand`, item);
    return success();
  }

  private getHoldingFamiliar(item: Item): Familiar | undefined {
    switch (toSlot(item)) {
      case $slot`weapon`:
        return $familiar`Disembodied Hand`;
      case $slot`off-hand`:
        return $familiar`Left-Hand Man`;
      default:
        return undefined;
    }
  }

  /**
   * Returns the bonus value associated with a given item.
   *
   * @param item The item to check the bonus of.
   * @returns The bonus assigned to that item.
   */
  public getBonus(item: Item): number {
    return this.bonuses.get(item) ?? 0;
  }

  /**
   * Applies a value to any existing bonus this item has, using a rule assigned by the `reducer` parameter
   *
   * @param item The item to try to apply a bonus to.
   * @param value The value to try to apply.
   * @param reducer Function that combines new and current bonus
   * @returns The total assigned bonus to that item.
   */
  public applyBonus(item: Item, value: number, reducer: (a: number, b: number) => number): number {
    const previous = this.getBonus(item);
    return this.setBonus(item, reducer(value, previous));
  }

  /**
   * Sets the bonus value of an item equal to a given value, overriding any current bonus assigned.
   *
   * @param item The item to try to apply a bonus to.
   * @param value The value to try to apply.
   * @returns The total assigned bonus to that item.
   */
  public setBonus(item: Item, value: number): number {
    this.bonuses.set(item, value);
    return value;
  }

  /**
   * Adds a value to any existing bonus this item has
   *
   * @param item The item to try to add a bonus to.
   * @param value The value to try to add.
   * @returns The total assigned bonus to that item.
   */
  public addBonus(item: Item, value: number): number {
    return this.applyBonus(item, value, (a, b) => a + b);
  }

  /**
   * Apply the given items' bonuses to the outfit, using a rule given by the reducer
   *
   * @param items A map containing items and their bonuses
   * @param reducer A way of combining new bonuses with existing bonuses
   */
  public applyBonuses(items: Map<Item, number>, reducer: (a: number, b: number) => number): void {
    for (const [item, value] of items) this.applyBonus(item, value, reducer);
  }

  /**
   * Sets the bonuses of the given items, overriding existing bonuses
   *
   * @param items Map containing items and bonuses
   */
  public setBonuses(items: Map<Item, number>): void {
    this.applyBonuses(items, (a) => a);
  }

  /**
   * Adds the bonuses of the given items to any existing bonuses they ahave
   *
   * @param items Map containing items and bonuses
   */
  public addBonuses(items: Map<Item, number>): void {
    this.applyBonuses(items, (a, b) => a + b);
  }

  private equipUsingFamiliar(item: Item, slot?: Slot): EquipResult {
    if (![undefined, $slot`familiar`].includes(slot)) return fail("");
    const familiar = this.getHoldingFamiliar(item);
    if (familiar === undefined) return fail("");

    if (this.equips.has($slot`familiar`))
      return fail(
        `Cannot equip ${item} with familiar since ${this.equips.get(
          $slot`familiar`
        )} is already equipped`
      );
    if (booleanModifier(item, "Single Equip"))
      return fail(
        `Cannot equip ${item} with familiar since ${this.equips.get(
          $slot`familiar`
        )} is already equipped`
      );
    const try_familiar = this.equipFamiliar(familiar);
    if (!try_familiar.success)
      return fail(`Cannot equip ${item} with familiar ${familiar}; ${try_familiar.reason}`);

    this.equips.set($slot`familiar`, item);
    return success();
  }

  private equipItem(item: Item, slot?: Slot): EquipResult {
    if (this.haveEquipped(item, slot)) return success();
    if (item === $item`none`) return this.equipItemNone(item, slot);

    const try_available = this.isAvailable(item);
    if (!try_available.success) return try_available;

    const reasons = [];
    for (const equip_method of [
      this.equipNonAccessory,
      this.equipAccessory,
      this.equipUsingDualWield,
      this.equipUsingFamiliar,
    ]) {
      const try_equip_method = equip_method(item, slot);
      if (try_equip_method.success) return success();
      else reasons.push(try_equip_method);
    }
    return mergeResults(reasons);
  }

  private equipFamiliar(familiar: Familiar): EquipResult {
    if (familiar === this.familiar) return success();
    if (this.familiar !== undefined)
      return fail(`Cannot use ${familiar} since we are already using ${this.familiar}`);
    if (familiar !== $familiar.none) {
      if (!have(familiar)) return fail(`Cannot use ${familiar} since we do not own it`);
      for (const slot of $slots`crown-of-thrones, buddy-bjorn`) {
        if (this.riders.get(slot) === familiar) {
          return fail(`Cannot use ${familiar} since it might be riding ${slot}`);
        }
      }
    }
    const item = this.equips.get($slot`familiar`);
    if (item !== undefined && item !== $item.none && !canEquip(familiar, item))
      return fail(`Cannot use ${familiar} since it cannot equip the required ${item}`);
    this.familiar = familiar;
    return success();
  }

  private equipSpec(spec: OutfitSpec): EquipResult {
    const reasons: EquipResult[] = [];

    for (const slotName of outfitSlots) {
      const slot =
        new Map([
          ["famequip", $slot`familiar`],
          ["offhand", $slot`off-hand`],
        ]).get(slotName) ?? toSlot(slotName);
      const itemOrItems = spec[slotName];
      if (itemOrItems !== undefined) {
        reasons.push(this.equipVerbose(itemOrItems, slot));
      }
    }
    for (const item of spec?.equip ?? []) {
      reasons.push(this.equipVerbose(item));
    }
    if (spec?.familiar !== undefined) {
      reasons.push(this.equipVerbose(spec.familiar));
    }
    this.avoid.push(...(spec?.avoid ?? []));
    this.skipDefaults = this.skipDefaults || (spec.skipDefaults ?? false);
    if (spec.modifier) {
      if (Array.isArray(spec.modifier)) this.modifier.push(...spec.modifier);
      else this.modifier.push(spec.modifier);
    }
    if (spec.modes) {
      reasons.push(this.setModesVerbose(spec.modes));
    }
    if (spec.riders) {
      if (spec.riders["buddy-bjorn"])
        reasons.push(this.equipRider(spec.riders["buddy-bjorn"], $slot`buddy-bjorn`));
      if (spec.riders["crown-of-thrones"])
        reasons.push(this.equipRider(spec.riders["crown-of-thrones"], $slot`crown-of-thrones`));
    }
    if (spec.bonuses) {
      this.addBonuses(spec.bonuses);
    }
    this.beforeDress(...(spec.beforeDress ?? []));
    this.afterDress(...(spec.afterDress ?? []));

    return mergeResults(reasons);
  }

  /**
   * Equip the first thing that can be equipped to the outfit.
   *
   * @param things The things to equip.
   * @param slot The slot to equip them.
   * @returns True if one of the things is equipped, and false otherwise.
   */
  public equipFirst(things: Item[] | Familiar[], slot?: Slot): boolean {
    // some() returns false on an empty array, yet every() returns true.
    // This keeps behavior consistent between slotful and slotless equipping.
    if (things.length === 0) return true;
    return things.some((val) => this.equip(val, slot));
  }

  /**
   * Equip a thing to the outfit, with a message if it fails.
   * See equip for a full behavior description.
   *
   * @param thing The thing or things to equip.
   * @param slot The slot to equip them.
   * @returns True if the thing was sucessfully equipped, or a reason why it could not be equipped.
   */
  public equipVerbose(thing: Equippable, slot?: Slot): EquipResult {
    if (Array.isArray(thing)) {
      if (slot !== undefined) {
        // Equip the first thing in the list that is possible.
        const reasons = [];
        for (const element of thing) {
          const try_equip = this.equipVerbose(element, slot);
          if (try_equip.success) return success();
          else reasons.push(try_equip);
        }
        return mergeResults(reasons);
      } else {
        // Try and equip everything;
        // Stopping on the first thing that cannot be equipped.
        for (const element of thing) {
          const result = this.equipVerbose(element);
          if (!result.success) return result;
        }
        return success();
      }
    }
    if (thing instanceof Item) return this.equipItem(thing, slot);
    if (thing instanceof Familiar) return this.equipFamiliar(thing);
    if (thing instanceof Outfit) return this.equipSpec(thing.spec());
    return this.equipSpec(thing);
  }

  /**
   * Equip a thing to the outfit.
   *
   * If no slot is given, then the thing will be equipped wherever possible
   * (possibly using dual-wielding, any of the accessory slots, or as
   * familiar equipment). If it is impossible to add this thing anywhere to
   * the outfit, this function will return false.
   *
   * If a slot is given, the item will be equipped only in that slot. If the
   * slot is filled with a different item, this function will return false.
   *
   * If the thing is already equipped in the provided slot, or if no slot is
   * given and the thing is already equipped in any slot, this function will
   * return true and not change the outfit.
   *
   * @param thing The thing or things to equip.
   * @param slot The slot to equip them.
   * @returns True if the thing was sucessfully equipped, and false otherwise.
   */
  public equip(thing: Equippable, slot?: Slot): boolean {
    return this.equipVerbose(thing, slot).success;
  }

  /**
   * Equip a thing to the outfit, and throw an exception if it fails.
   * See equip for a full behavior description.
   *
   * @param thing The thing or things to equip.
   * @param slot The slot to equip them.
   * @param context Additional context to include in the error.
   */
  public forceEquip(thing: Equippable, slot?: Slot, context?: string): void {
    const result = this.equipVerbose(thing, slot);
    if (result.success) return;
    const contextMsg = context ? ` (${context})` : "";
    throw `Unable to equip ${thing}${contextMsg}: ${result.success}`;
  }

  /**
   * Create a new outfit that confirms to a given spec. Return null if the outfit cannot be successfully created as such
   * @param spec The spec around which to build the outfit.
   * @param error An error to throw if we fail to equip the outfit; if this parameter is null, the return type will be Outfit | null
   * @returns A new outfit containing the inputted spec, or null if that is impossible.
   */
  static from(spec: OutfitSpec | Requirement): Outfit | null;
  static from(spec: OutfitSpec | Requirement, error: null): Outfit | null;
  static from(spec: OutfitSpec | Requirement, error: Error): Outfit;
  static from(spec: OutfitSpec | Requirement, error: Error | null = null): Outfit | null {
    const outfit = new Outfit();

    if (spec instanceof Requirement) {
      const result: OutfitSpec = {};
      result.modifier = spec.maximizeParameters;
      if (spec.maximizeOptions.forceEquip?.length) {
        result.equip = spec.maximizeOptions.forceEquip;
      }
      result.avoid = spec.maximizeOptions.preventEquip;
      result.bonuses = spec.maximizeOptions.bonusEquip;
      if (spec.maximizeOptions.modes) {
        result.modes = convertFromLibramModes(spec.maximizeOptions.modes);
      }
      // Not sure if this is necessary
      const cleanedResult = Object.fromEntries(
        [...Object.entries(result)].filter(([, v]) => v !== undefined),
      );
      return Outfit.from(cleanedResult);
    }

    const success = outfit.equip(spec);
    if (!success && error) throw error;
    return success ? outfit : null;
  }

  /**
   * Add a rider to the outfit.
   *
   * This function does *not* equip the corresponding item; it must be equipped separately.
   *
   * If a familiar is already specified as the rider that is different from the provided target, this function will return false and not change the rider.
   * @param target The familiar to use as the rider, or a ranked list of familiars to try to use as the rider.
   * @returns True if we successfully set the slot to a valid rider.
   */
  private equipRider(target: Familiar | Familiar[], slot: Slot): EquipResult {
    const current = this.riders.get(slot);
    const targets = Array.isArray(target) ? target : [target];

    if (current) {
      if (targets.includes(current)) return success();
      else return fail(`Cannot equip ${targets} in ${slot} since ${current} is already used`);
    }

    // Gather the set of riders that are equipped in other rider slots.
    const otherRiders = [...this.riders.entries()]
      .filter(([key]) => slot !== key)
      .map(([, value]) => value);

    const fam = targets.find((f) => have(f) && this.familiar !== f && !otherRiders.includes(f));
    if (fam) {
      this.riders.set(slot, fam);
      return success();
    }
    return fail(`Cannot equip any of ${targets} in ${slot}`);
  }

  /**
   * Add a bjornified familiar to the outfit.
   *
   * This function does *not* equip the buddy bjorn itself; it must be equipped separately.
   *
   * If a familiar is already specified for the buddy bjorn that is different from the provided target, this function will return false and not change the buddy bjorn.
   * @param target The familiar to bjornify, or a ranked list of familiars to try to bjornify.
   * @returns True if we successfully set the bjorn to a valid target.
   */
  bjornify(target: Familiar | Familiar[]): boolean {
    return this.equipRider(target, $slot`buddy-bjorn`).success;
  }

  /**
   * Add anenthroned familiar to the outfit.
   *
   * This function does *not* equip the crown of thrones itself; it must be equipped separately.
   *
   * If a familiar is already specified for the crown of thrones that is different from the provided target, this function will return false and not change the crown of thrones.
   * @param target The familiar to enthrone, or a ranked list of familiars to try to enthrone.
   * @returns True if we successfully set the enthrone to a valid target.
   */
  enthrone(target: Familiar | Familiar[]): boolean {
    return this.equipRider(target, $slot`crown-of-thrones`).success;
  }

  /**
   * Set the provided modes for items that may be equipped in the outfit.
   *
   * This function does *not* equip items for the set modes; they must be
   * equipped separately.
   *
   * If a mode is already set for an item that is different from the provided
   * mode, this function will return false and not change the mode for that
   * item. (But other modes might still be changed if they are compatible.)
   *
   * Note that the superhero and instuctions of a retrocape can be set
   * independently (`undefined` is treated as "don't care").
   *
   * @param modes Modes to set in this outfit.
   * @returns True if all modes were sucessfully set, and false otherwise.
   */
  setModes(modes: Modes): boolean {
    return this.setModesVerbose(modes).success;
  }

  /**
   * See setModes for behavior description.
   *
   * @param modes Modes to set in this outfit.
   * @returns True if all modes were sucessfully set, or a reason if they were not.
   */
  private setModesVerbose(modes: Modes): EquipResult {
    const reasons: string[] = [];

    // Check if the new modes are compatible with existing modes
    for (const mode of modeableCommands) {
      if (mode === "retrocape") continue; // checked below
      if (this.modes[mode] && modes[mode] && this.modes[mode] !== modes[mode]) {
        reasons.push(
          `Mode ${mode} cannot be ${modes[mode]} since it is already ${this.modes[mode]}`
        );
      }
    }

    // Check if retrocape modes are compatible
    // (Parts that are undefined are compatible with everything)
    if (this.modes["retrocape"] && modes["retrocape"]) {
      if (
        this.modes["retrocape"][0] &&
        modes["retrocape"][0] &&
        this.modes["retrocape"][0] !== modes["retrocape"][0]
      ) {
        reasons.push(
          `Mode retrocape0 cannot be ${modes["retrocape"][0]} since it is already ${this.modes["retrocape"][0]}`
        );
      }

      if (
        this.modes["retrocape"][1] &&
        modes["retrocape"][1] &&
        this.modes["retrocape"][1] !== modes["retrocape"][1]
      ) {
        reasons.push(
          `Mode retrocape1 cannot be ${modes["retrocape"][1]} since it is already ${this.modes["retrocape"][1]}`
        );
      }

      this.modes["retrocape"][0] = this.modes["retrocape"][0] ?? modes["retrocape"][0];
      this.modes["retrocape"][1] = this.modes["retrocape"][1] ?? modes["retrocape"][1];
    }

    this.modes = {
      ...modes,
      ...this.modes, // if conflict, default to the preexisting modes
    };
    if (reasons.length === 0) return success();
    return fail(reasons.join(". "));
  }

  /**
   * Check if it is possible to equip a thing to this outfit using .equip().
   *
   * This does not change the current outfit.
   *
   * @param thing The thing to equip.
   * @param slot The slot to equip them.
   * @returns True if this thing can be equipped.
   */
  canEquip(thing: Equippable, slot?: Slot): boolean {
    const outfit = this.clone();
    return outfit.equip(thing, slot);
  }

  /**
   * Check if it is possible to equip a thing to this outfit using .equip(); if it is, do so.
   *
   * This does change the current outfit.
   * @param thing The thing to equip.
   * @param slot The slot to equip them.
   * @returns True if this thing was successfully equipped.
   */
  tryEquip(thing: Equippable, slot?: Slot): boolean {
    return this.canEquip(thing, slot) && this.equip(thing, slot);
  }

  afterDress(...actions: (() => void)[]): void {
    this.postActions.push(...actions);
  }

  beforeDress(...actions: (() => void)[]): void {
    this.preActions.push(...actions);
  }

  /**
   * Equip this outfit.
   */
  private _dress(refreshed: boolean): void {
    if (this.familiar) useFamiliar(this.familiar);
    const targetEquipment = Array.from(this.equips.values());
    const usedSlots = new Set<Slot>();

    // First, we equip non-accessory equipment.
    const nonaccessorySlots = $slots`weapon, off-hand, hat, back, shirt, pants, familiar`;

    const bjorn = this.riders.get($slot`buddy-bjorn`);
    if (
      bjorn &&
      (this.equips.get($slot`back`) === $item`Buddy Bjorn` || this.getBonus($item`Buddy Bjorn`))
    ) {
      usedSlots.add($slot`buddy-bjorn`);
      usedSlots.add($slot`crown-of-thrones`);
    }

    const crown = this.riders.get($slot`crown-of-thrones`);
    if (
      crown &&
      (this.equips.get($slot`hat`) === $item`Crown of Thrones` ||
        this.getBonus($item`Crown of Thrones`))
    ) {
      usedSlots.add($slot`buddy-bjorn`);
      usedSlots.add($slot`crown-of-thrones`);
    }

    // We must manually remove equipment that we want to use in a different
    // slot than where it is currently equipped, to avoid a mafia issue.
    // Order is anchored here to prevent DFSS shenanigans
    for (const slot of nonaccessorySlots) {
      if (
        (targetEquipment.includes(equippedItem(slot)) &&
          this.equips.get(slot) !== equippedItem(slot)) ||
        this.avoid.includes(equippedItem(slot)) ||
        (slot === $slot`weapon` &&
          weaponHands(equippedItem(slot)) !== 1 &&
          this.equips.has($slot`offhand`) &&
          !this.equips.has($slot`weapon`))
      )
        equip(slot, $item.none);
    }

    // Then we equip all the non-accessory equipment.
    for (const slot of nonaccessorySlots) {
      const equipment = this.equips.get(slot);
      if (equipment) {
        equip(slot, equipment);
        usedSlots.add(slot);
      }
    }

    // Next, we equip accessories
    const accessorySlots = $slots`acc1, acc2, acc3`;
    const accessoryEquips = accessorySlots
      .map((slot) => this.equips.get(slot))
      .filter((item) => item !== undefined) as Item[];

    // To plan how to equip accessories, first check which accessories are
    // already equipped in some accessory slot. There is no need to move them,
    // since KoL doesn't care what order accessories are equipped in.
    const missingAccessories = []; // accessories that are not already equipped
    for (const accessory of accessoryEquips) {
      const alreadyEquipped = accessorySlots.find(
        (slot) => !usedSlots.has(slot) && equippedItem(slot) === accessory,
      );
      if (alreadyEquipped) {
        usedSlots.add(alreadyEquipped);
      } else {
        missingAccessories.push(accessory);
      }
    }

    // Then, for all accessories that are not currently equipped, use the first
    // open slot to place them.
    for (const accessory of missingAccessories) {
      const unusedSlot = accessorySlots.find((slot) => !usedSlots.has(slot));
      if (unusedSlot === undefined) {
        // This should only occur if there is a bug in .dress()
        throw `No accessory slots remaining`;
      }
      equip(unusedSlot, accessory);
      usedSlots.add(unusedSlot);
    }

    // Remaining slots are filled by the maximizer
    const modes = convertToLibramModes(this.modes);
    if (this.modifier.length > 0 || [...this.bonuses].filter(([, value]) => value).length > 0) {
      const allRequirements = [
        new Requirement(this.modifier, {
          preventSlot: [...usedSlots],
          preventEquip: this.avoid,
          modes: modes,
          bonusEquip: this.bonuses,
        }),
      ];

      if (refreshed) allRequirements.push(FORCE_REFRESH_REQUIREMENT);

      if (!Requirement.merge(allRequirements).maximize()) {
        if (!refreshed) {
          cliExecute("refresh inventory");
          this._dress(true);
          return;
        } else throw new Error("Failed to maximize properly!");
      }
      logprint(`Maximize: ${this.modifier}`);
    }

    // Set the modes of any equipped items.
    applyModes(modes);
    // Handle the rider slots next
    if (bjorn && haveEquipped($item`Buddy Bjorn`)) {
      if (myEnthronedFamiliar() === bjorn) enthroneFamiliar($familiar.none);
      if (myBjornedFamiliar() !== bjorn) bjornifyFamiliar(bjorn);
    }
    if (crown && haveEquipped($item`Crown of Thrones`)) {
      if (myBjornedFamiliar() === crown) bjornifyFamiliar($familiar.none);
      if (myEnthronedFamiliar() !== crown) enthroneFamiliar(crown);
    }

    // Verify that all equipment was indeed equipped
    if (this.familiar !== undefined && myFamiliar() !== this.familiar)
      throw `Failed to fully dress (expected: familiar ${this.familiar})`;
    for (const slot of nonaccessorySlots) {
      if (this.equips.has(slot) && equippedItem(slot) !== this.equips.get(slot)) {
        throw `Failed to fully dress (expected: ${slot} ${this.equips.get(slot)})`;
      }
    }
    for (const accessory of accessoryEquips) {
      if (
        mafiaEquippedAmount(accessory) < accessoryEquips.filter((acc) => acc === accessory).length
      ) {
        throw `Failed to fully dress (expected: acc ${accessory})`;
      }
    }
    for (const [rider, throne, checkingFunction] of [
      [$slot`buddy-bjorn`, $item`Buddy Bjorn`, myBjornedFamiliar],
      [$slot`crown-of-thrones`, $item`Crown of Thrones`, myEnthronedFamiliar],
    ] as const) {
      const wanted = this.riders.get(rider);
      if ([...this.equips.values()].includes(throne) && wanted && checkingFunction() !== wanted) {
        throw `Failed to fully dress: (expected ${rider} ${wanted})`;
      }
    }
  }

  public dress(): void {
    for (const action of this.preActions) action();
    this._dress(false);
    for (const action of this.postActions) action();
  }

  /**
   * Build an Outfit identical to this outfit.
   */
  clone(): Outfit {
    const result = new Outfit();
    result.equips = new Map(this.equips);
    result.skipDefaults = this.skipDefaults;
    result.familiar = this.familiar;
    result.modifier = [...this.modifier];
    result.avoid = [...this.avoid];
    result.modes = { ...this.modes };
    result.riders = new Map(this.riders);
    result.bonuses = new Map(this.bonuses);
    result.beforeDress(...this.preActions);
    result.afterDress(...this.postActions);
    return result;
  }

  /**
   * Build an OutfitSpec identical to this outfit.
   */
  spec(): OutfitSpec {
    const result: OutfitSpec = {
      modifier: [...this.modifier],
      avoid: [...this.avoid],
      skipDefaults: this.skipDefaults,
      modes: { ...this.modes },
      bonuses: new Map(this.bonuses),
    };

    if (this.familiar) result.familiar = this.familiar;

    // Add all equipment forced in a particular slot
    for (const slotName of outfitSlots) {
      const entry = this.equips.get(
        new Map([
          ["famequip", $slot`familiar`],
          ["offhand", $slot`off-hand`],
        ]).get(slotName) ?? toSlot(slotName),
      );

      if (entry) result[slotName] = entry;
    }

    // Include the riders
    const riders: OutfitRiders = {};
    const buddyRider = this.riders.get($slot`buddy-bjorn`);
    if (buddyRider !== undefined) riders["buddy-bjorn"] = buddyRider;
    const throneRider = this.riders.get($slot`crown-of-thrones`);
    if (throneRider !== undefined) riders["crown-of-thrones"] = throneRider;
    if (buddyRider !== undefined || throneRider !== undefined) result.riders = riders;

    if (this.preActions.length) result.beforeDress = this.preActions;
    if (this.postActions.length) result.afterDress = this.postActions;

    return result;
  }
}

/**
 * Get the modes of this outfit in a type compatible with Libram.
 *
 * This conversion is needed since we store the retrocape modes
 * internally as an array, but libram uses a string.
 *
 * @returns The modes equipped to this outfit.
 */
export function convertToLibramModes(
  modes: Modes,
): LibramModes & Record<keyof LibramModes, unknown> {
  return {
    backupcamera: modes["backupcamera"],
    umbrella: modes["umbrella"],
    snowsuit: modes["snowsuit"],
    edpiece: modes["edpiece"],
    retrocape: modes["retrocape"]?.filter((s) => s !== undefined).join(" "),
    parka: modes["parka"],
    jillcandle: modes["jillcandle"],
  };
}

export function convertFromLibramModes(modes: LibramModes): Modes {
  return (modes.retrocape ? { ...modes, retrocape: modes.retrocape.split(" ") } : modes) as Modes;
}

/**
 * Get the current modes of all items.
 *
 * @returns The current mode settings for all items, equipped or not.
 */
export function getCurrentModes(): Modes & Record<keyof Modes, unknown> {
  return {
    backupcamera: getMode("backupCameraMode", ["ml", "meat", "init"]),
    umbrella: getMode("umbrellaState", [
      "broken",
      "forward-facing",
      "bucket style",
      "pitchfork style",
      "constantly twirling",
      "cocoon",
    ]),
    snowsuit: getMode("snowsuit", ["eyebrows", "smirk", "nose", "goatee", "hat"]),
    edpiece: getMode("edPiece", ["bear", "owl", "puma", "hyena", "mouse", "weasel", "fish"]),
    retrocape: [
      getMode("retroCapeSuperhero", ["vampire", "heck", "robot"]),
      getMode("retroCapeWashingInstructions", ["hold", "thrill", "kiss", "kill"]),
    ],
    parka: getMode("parkaMode", [
      "kachungasaur",
      "dilophosaur",
      "ghostasaurus",
      "spikolodon",
      "pterodactyl",
    ]),
    jillcandle: getMode("jillcandle", ["disco", "ultraviolet", "reading", "red"]),
  };
}

/**
 * Get the current value for a mode in a type-safe way.
 *
 * @param property The mafia property for the mode.
 * @param options A typed list of options for the mode.
 * @returns The mode if the property value matched a valid option, or undefined.
 */
function getMode<T extends string>(property: string, options: readonly T[]): T | undefined {
  const val = get(property, "");
  return options.find((s) => s === val); // .includes has type issues
}
