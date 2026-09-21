import type { PickerLight } from './target-picker';
import type { MappingRule } from '../mapping/mapping-types';
import type { MappingRuleDto } from '../validation/pairing-dto';
import type { TargetSpec } from '../outputs/light-intent';

/**
 * What the mapping screen is shown, and what it sends back.
 *
 * This was the largest block of untested logic in the app, and it was untested
 * for a structural reason rather than a careless one: it lived inside a class
 * that `extends Homey.Driver`, which no test can import (platform §13). The same
 * split `lib/devices/device-lifecycle.ts` made one layer down, made here.
 *
 * The rule it is really about is the ONE-LIGHT COLLAPSE. Choosing a single lamp
 * means "all lights" and "that lamp" are the same lamp, and rendering both gives
 * the user an "All lights" section open at the top and, below it, a collapsed
 * section offering overrides that can never override anything. Getting that
 * collapse subtly wrong is invisible on a two-lamp Homey and wrong on a one-lamp
 * one — which is exactly the shape of bug that reaches a release.
 *
 * Nothing here translates. Every user-visible word arrives as an argument.
 */

/** One section on the mapping screen. */
export interface MappingGroup {
  key: string;
  label: string;
  zoneName?: string;
  capabilities?: string[];
  /** null means "inherit the controller's own targets" — every chosen light. */
  deviceIds: string[] | null;
}

/** One row's state, as the screen holds it. */
export interface MappingRuleRow {
  id: string;
  function: string;
  inputKey: string | null;
  groupKey: string;
}

/** The single chosen lamp, or null when there is more than one. */
export function singleLightOf(lights: PickerLight[]): PickerLight | null {
  return lights.length === 1 ? lights[0]! : null;
}

/**
 * One section per light, plus an "all lights" one — so an assignment reads as
 * "this button does this to this lamp", which is how people think about it.
 *
 * With one light, ONE section. It is keyed `'__all__'` so a rule still stores as
 * "inherit" and the section still opens by default, but it is named after the
 * lamp and carries the lamp's capabilities — so a function that lamp cannot
 * perform drops off the list, which the bare `'__all__'` group never does.
 *
 * @param allLightsLabel resolved by the driver; `lib/` cannot translate
 */
export function mappingGroups(lights: PickerLight[], allLightsLabel: string): MappingGroup[] {
  const single = singleLightOf(lights);
  if (single) {
    return [{
      key: '__all__',
      label: single.name,
      zoneName: single.zoneName,
      capabilities: single.capabilities,
      deviceIds: null,
    }];
  }

  return [
    { key: '__all__', label: allLightsLabel, deviceIds: null },
    ...lights.map(light => ({
      key: light.id,
      label: light.name,
      zoneName: light.zoneName,
      capabilities: light.capabilities,
      deviceIds: [light.id],
    })),
  ];
}

/**
 * Stored rules, as rows against the sections above.
 *
 * The collapse applies here too, and this is the half that bites. A rule saved
 * against a light's OWN id — by a repair that later narrowed the selection down
 * to just that light — would otherwise name a group that is no longer rendered,
 * and the row it belongs to would silently vanish from the screen. The user's
 * mapping is still in the profile; there is simply nowhere on the page it
 * appears.
 *
 * A rule naming SEVERAL lights reads here as `__all__`, and that is a limit of
 * this screen rather than of the rule: a section is one light or all of them,
 * which is the most the screen these rows were written for could say. The
 * buttons flow stores subsets and draws them itself — `getButtons` names them on
 * the row and `getGesture` ticks them in a checklist. Nothing renders these rows
 * any more; `getMapping` is kept because `setRules` is, and `setRules` is kept
 * because it is a scriptable Web API surface the hardware pass drives
 * (platform §14).
 */
export function mappingRuleRows(rules: MappingRule[], lights: PickerLight[]): MappingRuleRow[] {
  const single = singleLightOf(lights);

  return rules.map(rule => ({
    id: rule.id,
    function: rule.function,
    inputKey: rule.inputKey,
    groupKey: single
      ? '__all__'
      : rule.target?.kind === 'devices' && rule.target.deviceIds.length === 1
        ? rule.target.deviceIds[0]!
        : '__all__',
  }));
}

/**
 * A row's section, back to the target a rule stores.
 *
 * The inverse of the `groupKey` above, and the reason it is here rather than
 * inline: the two must agree, and a round trip through both is the only way to
 * say so in a test.
 *
 * It takes a LIST because a rule may name several lights — the buttons flow
 * stores a subset of the device's own, and one device id was the most the
 * screen this replaced could say. The legacy spelling is read one layer up, in
 * `validateMappingRules`, which turns either spelling into this one.
 */
export function ruleTargetFrom(deviceIds: string[] | null): TargetSpec | null {
  return deviceIds && deviceIds.length > 0 ? { kind: 'devices', deviceIds } : null;
}

/**
 * One validated row, as the rule a profile stores.
 *
 * The whole of the conversion, in one place, because it was in two and they
 * disagreed. `setGesture` carried the preset through and `setRules` — the bulk
 * path — rebuilt the rule field by field and left it behind, so a
 * `brightness_set` or a `color_set` arriving that way was stored as a job that
 * says "set a value" and names none. `validateControllerProfile` refuses
 * exactly that shape, so the device paired, wrote its store and went
 * unavailable on the next `onInit` with nothing naming the row that did it.
 *
 * The preset is not optional-if-present-please: `validateMappingRules` has
 * already dropped any row whose function needs a value and has none, so every
 * DTO reaching here carries what it must and the spread is faithful rather than
 * forgiving.
 *
 * Here rather than inline in the driver for the reason everything else in this
 * file is: a file containing `extends Homey.Driver` cannot be imported by a
 * test (platform §13), and one shared function is the only way the two paths
 * can be held to the same answer.
 */
export function storedRuleFrom(dto: MappingRuleDto): MappingRule {
  return {
    id: dto.id,
    function: dto.function,
    inputKey: dto.inputKey,
    // null inherits the controller's own targets.
    target: ruleTargetFrom(dto.deviceIds),
    ...(dto.preset !== undefined ? { preset: dto.preset } : {}),
  };
}
