import {
  booleanModifier,
  canEquip,
  equip,
  equippedAmount,
  equippedItem,
  Familiar,
  Item,
  logprint,
  weaponHands as mafiaWeaponHands,
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
  have,
  MaximizeOptions,
  Requirement,
} from "libram";
import { outfitSlots, OutfitSpec } from "./task";

const weaponHands = (i?: Item) => (i ? mafiaWeaponHands(i) : 0);

export class Outfit {
  equips: Map<Slot, Item> = new Map<Slot, Item>();
  skipDefaults = false;
  familiar?: Familiar;
  modifier = "";
  avoid: Item[] = [];

  private countEquipped(item: Item): number {
    return [...this.equips.values()].filter((i) => i === item).length;
  }

  private isAvailable(item: Item): boolean {
    if (this.avoid?.includes(item)) return false;
    if (!have(item, this.countEquipped(item) + 1)) return false;
    if (booleanModifier(item, "Single Equip") && this.countEquipped(item) > 0) return false;
    return true;
  }

  private haveEquipped(item: Item, slot?: Slot): boolean {
    if (slot === undefined) return this.countEquipped(item) > 0;
    return this.equips.get(slot) === item;
  }

  private equipItemNone(item: Item, slot?: Slot): boolean {
    if (item !== $item.none) return false;
    if (slot === undefined) return true;
    if (this.equips.has(slot)) return false;
    this.equips.set(slot, item);
    return true;
  }

  private equipNonAccessory(item: Item, slot?: Slot) {
    if ($slots`acc1, acc2, acc3`.includes(toSlot(item))) return false;
    if (slot !== undefined && slot !== toSlot(item)) return false;
    if (this.equips.has(toSlot(item))) return false;
    switch (toSlot(item)) {
      case $slot`off-hand`:
        if (this.equips.has($slot`weapon`) && weaponHands(this.equips.get($slot`weapon`)) !== 1) {
          return false;
        }
        break;
      case $slot`familiar`:
        if (this.familiar !== undefined && !canEquip(this.familiar, item)) return false;
    }
    if (toSlot(item) !== $slot`familiar` && !canEquip(item)) return false;
    this.equips.set(toSlot(item), item);
    return true;
  }

  private equipAccessory(item: Item, slot?: Slot): boolean {
    if (![undefined, ...$slots`acc1, acc2, acc3`].includes(slot)) return false;
    if (toSlot(item) !== $slot`acc1`) return false;
    if (!canEquip(item)) return false;
    if (slot === undefined) {
      // We don't care which of the accessory slots we equip in
      const empty = $slots`acc1, acc2, acc3`.find((s) => !this.equips.has(s));
      if (empty === undefined) return false;
      this.equips.set(empty, item);
    } else {
      if (this.equips.has(slot)) return false;
      this.equips.set(slot, item);
    }
    return true;
  }

  private equipUsingDualWield(item: Item, slot?: Slot): boolean {
    if (![undefined, $slot`off-hand`].includes(slot)) return false;
    if (toSlot(item) !== $slot`weapon`) return false;
    if (this.equips.has($slot`weapon`) && weaponHands(this.equips.get($slot`weapon`)) !== 1) {
      return false;
    }
    if (this.equips.has($slot`off-hand`)) return false;
    if (!have($skill`Double-Fisted Skull Smashing`)) return false;
    if (weaponHands(item) !== 1) return false;
    if (!canEquip(item)) return false;
    this.equips.set($slot`off-hand`, item);
    return true;
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

  private equipUsingFamiliar(item: Item, slot?: Slot): boolean {
    if (![undefined, $slot`familiar`].includes(slot)) return false;
    if (this.equips.has($slot`familiar`)) return false;
    if (booleanModifier(item, "Single Equip")) return false;
    const familiar = this.getHoldingFamiliar(item);
    if (familiar === undefined || !this.equip(familiar)) return false;
    this.equips.set($slot`familiar`, item);
    return true;
  }

  private equipItem(item: Item, slot: Slot | undefined, duplicate: boolean): boolean {
    return (
      (!duplicate && this.haveEquipped(item, slot)) ||
      this.equipItemNone(item, slot) ||
      (this.isAvailable(item) &&
        (this.equipNonAccessory(item, slot) ||
          this.equipAccessory(item, slot) ||
          this.equipUsingDualWield(item, slot) ||
          this.equipUsingFamiliar(item, slot)))
    );
  }

  private equipFamiliar(familiar: Familiar): boolean {
    if (familiar === this.familiar) return true;
    if (this.familiar !== undefined) return false;
    if (familiar !== $familiar.none && !have(familiar)) return false;
    const item = this.equips.get($slot`familiar`);
    if (item !== undefined && item !== $item.none && !canEquip(familiar, item)) return false;
    this.familiar = familiar;
    return true;
  }

  private equipSpec(spec: OutfitSpec): boolean {
    let succeeded = true;
    for (const slotName of outfitSlots) {
      const slot =
        new Map([
          ["famequip", $slot`familiar`],
          ["offhand", $slot`off-hand`],
        ]).get(slotName) ?? toSlot(slotName);
      const itemOrItems = spec[slotName];
      if (itemOrItems !== undefined && !this.equip(itemOrItems, slot)) succeeded = false;
    }
    for (const item of spec?.equip ?? []) {
      if (!this.equipItem(item, undefined, false)) succeeded = false;
    }
    if (spec?.familiar !== undefined) {
      if (!this.equip(spec.familiar)) succeeded = false;
    }
    this.avoid.push(...(spec?.avoid ?? []));
    this.skipDefaults = this.skipDefaults || (spec.skipDefaults ?? false);
    if (spec.modifier) {
      this.modifier = this.modifier + (this.modifier ? ", " : "") + spec.modifier;
    }
    return succeeded;
  }

  /**
   * Equip a thing to the outfit.
   *
   * If a slot is given, the item will be equipped in that slot. If no slot
   * is given, then the item will be equipped wherever possible (possibly using
   * dual-wielding, or as familiar equipment).
   *
   * If the thing is already equipped in the provided slot, or if no slot is
   * given and the thing is already equipped in any slot, this function will
   * return true and not change the outfit.
   *
   * @param thing The thing or things to equip.
   * @param slot The slot to equip them.
   * @returns True if the thing was sucessfully equipped, and false otherwise.
   */
  equip(thing: Item | Familiar | OutfitSpec | Item[], slot?: Slot): boolean {
    if (Array.isArray(thing)) {
      if (slot !== undefined) return thing.some((val) => this.equip(val, slot));
      return thing.every((val) => this.equip(val));
    }
    if (thing instanceof Item) return this.equipItem(thing, slot, false);
    if (thing instanceof Familiar) return this.equipFamiliar(thing);
    return this.equipSpec(thing);
  }

  /**
   * Equip a thing to the outfit, even if it is already equipped.
   *
   * @param thing The thing or things to equip.
   * @returns True if the thing was sucessfully equipped, and false otherwise.
   */
  equipDuplicate(thing: Item | Item[]): boolean {
    if (Array.isArray(thing)) {
      return thing.every((val) => this.equipDuplicate(val));
    }
    return this.equipItem(thing, undefined, true);
  }

  /**
   * Check if it is possible to equip a thing to this outfit using .equip().
   *
   * @param thing The thing to equip.
   * @returns True if this thing can be equipped.
   */
  canEquip(thing: Item | Familiar | OutfitSpec | Item[]): boolean {
    const outfit = this.clone();
    return outfit.equip(thing);
  }

  /**
   * Equip this outfit.
   * @param extraOptions Passed to any maximizer calls made.
   */
  dress(extraOptions?: Partial<MaximizeOptions>): void {
    if (this.familiar) useFamiliar(this.familiar);
    const targetEquipment = Array.from(this.equips.values());
    //Order is anchored here to prevent DFSS shenanigans
    const nonaccessorySlots = $slots`weapon, off-hand, hat, back, shirt, pants, familiar, buddy-bjorn, crown-of-thrones`;
    const accessorySlots = $slots`acc1, acc2, acc3`;
    for (const slot of nonaccessorySlots) {
      if (
        (targetEquipment.includes(equippedItem(slot)) &&
          this.equips.get(slot) !== equippedItem(slot)) ||
        this.avoid.includes(equippedItem(slot))
      )
        equip(slot, $item.none);
    }

    for (const slot of nonaccessorySlots) {
      const equipment = this.equips.get(slot);
      if (equipment) equip(slot, equipment);
    }

    // Since KoL doesn't care what order accessories are equipped in,
    // we forget the requested accessory slots and ensure all accessories
    // are equipped somewhere.
    const accessoryEquips = $slots`acc1, acc2, acc3`
      .map((slot) => this.equips.get(slot))
      .filter((item) => item !== undefined) as Item[];
    for (const slot of accessorySlots) {
      const toEquip = accessoryEquips.find(
        (equip) =>
          equippedAmount(equip) < accessoryEquips.filter((accessory) => accessory === equip).length
      );
      if (!toEquip) break;
      const currentEquip = equippedItem(slot);
      //We never want an empty accessory slot
      if (
        currentEquip === $item.none ||
        equippedAmount(currentEquip) >
          accessoryEquips.filter((accessory) => accessory === currentEquip).length
      ) {
        equip(slot, toEquip);
      }
    }

    if (this.modifier) {
      const allRequirements = [
        new Requirement([this.modifier], {
          preventSlot: [...this.equips.keys()],
          forceEquip: accessoryEquips,
          preventEquip: this.avoid,
        }),
      ];
      if (extraOptions) allRequirements.push(new Requirement([], extraOptions));

      if (!Requirement.merge(allRequirements).maximize()) {
        throw `Unable to maximize ${this.modifier}`;
      }
      logprint(`Maximize: ${this.modifier}`);
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
      if (equippedAmount(accessory) < accessoryEquips.filter((acc) => acc === accessory).length) {
        throw `Failed to fully dress (expected: acc ${accessory})`;
      }
    }
  }

  clone(): Outfit {
    const result = new Outfit();
    result.equips = new Map(this.equips);
    result.skipDefaults = this.skipDefaults;
    result.familiar = this.familiar;
    result.modifier = this.modifier;
    result.avoid = [...this.avoid];
    return result;
  }
}
