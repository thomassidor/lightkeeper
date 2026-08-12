import type { DiscoveredTriggerCard } from '../../lib/inputs/event-normalizer';

/**
 * RAW card schemas, transcribed verbatim from a live Homey Pro 2023 during the
 * Phase 0 spike (firmware 13.4.0). Device IDs are replaced with stable
 * placeholders; nothing else is altered.
 *
 * §11.2 requires raw fixture data be kept separate from the normalised expected
 * catalogue — that separation is what proves the normalizer, rather than the
 * fixture, is doing the work. The expected catalogues live in the test files.
 */

const card = (
  deviceId: string,
  shortId: string,
  title: string,
  args: DiscoveredTriggerCard['args'] = [],
  tokens: DiscoveredTriggerCard['tokens'] = [],
): DiscoveredTriggerCard => ({
  id: `homey:device:${deviceId}:${shortId}`,
  shortId,
  uri: `homey:flowcardtrigger:homey:device:${deviceId}:${shortId}`,
  title,
  args,
  tokens,
});

const dropdown = (name: string, ids: string[]) => ({
  name,
  type: 'dropdown',
  values: ids.map(id => ({ id })),
});

/**
 * IKEA STYRBAR E2001/E2002 — Zigbee local, `com.ikea.tradfri:remote_control_n2`.
 * Fixed cards, no arguments, no tokens. Up and down carry BOTH press and
 * long-press; left and right carry press only.
 */
export const STYRBAR_DEVICE_ID = 'styrbar-0000-0000-0000-000000000001';
export const STYRBAR_CARDS: DiscoveredTriggerCard[] = [
  card(STYRBAR_DEVICE_ID, 'n2_on', 'Higher brightness was pressed'),
  card(STYRBAR_DEVICE_ID, 'n2_off', 'Lower brightness was pressed'),
  card(STYRBAR_DEVICE_ID, 'n2_dim_up', 'Higher brightness was long pressed'),
  card(STYRBAR_DEVICE_ID, 'n2_dim_down', 'Lower brightness was long pressed'),
  card(STYRBAR_DEVICE_ID, 'n2_scene_up', 'Right button was pressed'),
  card(STYRBAR_DEVICE_ID, 'n2_scene_down', 'Left button was pressed'),
  // Capability cards the device also carries — the normalizer must ignore these.
  card(STYRBAR_DEVICE_ID, 'measure_battery_threshold_above', 'Battery (%) becomes greater than…',
    [{ name: 'threshold', type: 'number' }]),
  card(STYRBAR_DEVICE_ID, 'measure_battery_changed', 'The battery level changed',
    [], [{ id: 'value', type: 'number' }]),
];

/**
 * Philips Hue Dimmer v2 RWL022 via the Hue Bridge — `nl.philips.hue:dimmerswitch`.
 * NOTE: exposes press only. §2.3 expected press and long-press; through this
 * integration no hold exists, so none may be offered (§5.5).
 */
export const HUE_DIMMER_DEVICE_ID = 'huedimmer-0000-0000-0000-000000000002';
export const HUE_DIMMER_CARDS: DiscoveredTriggerCard[] = [
  card(HUE_DIMMER_DEVICE_ID, 'dimmerswitch_button_pressed', 'A button is pressed',
    [dropdown('button', ['on', 'increase_brightness', 'decrease_brightness', 'off'])]),
  card(HUE_DIMMER_DEVICE_ID, 'measure_battery_threshold_below', 'Battery (%) becomes less than…',
    [{ name: 'threshold', type: 'number' }]),
];

/**
 * Philips Hue Tap Dial RDM002 via the Hue Bridge — `nl.philips.hue:tapdial`.
 * Four buttons as a dropdown, plus a dial whose magnitude arrives as the
 * `steps` token ("Steps (1000/turn)") on rotation STOPPED.
 */
export const TAP_DIAL_DEVICE_ID = 'tapdial-0000-0000-0000-000000000003';
export const TAP_DIAL_CARDS: DiscoveredTriggerCard[] = [
  card(TAP_DIAL_DEVICE_ID, 'tapdial_button_pressed', 'A button is pressed',
    [dropdown('button', ['button1', 'button2', 'button3', 'button4'])]),
  card(TAP_DIAL_DEVICE_ID, 'tapdial_dial_rotation_started', 'Dial rotated',
    [dropdown('rotate_direction', ['either', 'counter_clock_wise', 'clock_wise'])]),
  card(TAP_DIAL_DEVICE_ID, 'tapdial_dial_rotation_stopped', 'Dial stops rotating',
    [dropdown('rotate_direction', ['either', 'counter_clock_wise', 'clock_wise'])],
    // The title states the scale, and the runtime needs it: 1000 steps per turn
    // means a small nudge reports ~150.
    [{ id: 'steps', type: 'number', title: 'Steps (1000/turn)' }]),
  card(TAP_DIAL_DEVICE_ID, 'tapdial_dial_rotation_dimmed', 'Dial dimmed',
    [], [{ id: 'dim_level', type: 'number', title: 'Resulting dim level' }]),
];

/**
 * IKEA BILRESA scroll wheel via Matter/Thread —
 * `com.ikea.tradfri:matter_bilresa_scroll_wheel`.
 *
 * `switch_multi_press_multi` is §5.4's warning made real: button 1–9 AND
 * count 1–18 is 162 combinations, and a count reaching 18 is plainly detents
 * rather than repeated clicks.
 */
export const BILRESA_DEVICE_ID = 'bilresa-0000-0000-0000-000000000004';
const NINE = ['1', '2', '3', '4', '5', '6', '7', '8', '9'];
const EIGHTEEN = Array.from({ length: 18 }, (_, i) => String(i + 1));
export const BILRESA_CARDS: DiscoveredTriggerCard[] = [
  card(BILRESA_DEVICE_ID, 'switch_initial_press_multi', 'A button was pressed',
    [dropdown('button', NINE)]),
  card(BILRESA_DEVICE_ID, 'switch_press_multi', 'A button was clicked',
    [dropdown('button', NINE)]),
  card(BILRESA_DEVICE_ID, 'switch_long_press_multi', 'A button was long pressed and released',
    [dropdown('button', ['3', '6', '9'])]),
  card(BILRESA_DEVICE_ID, 'switch_long_press2_multi', 'A button was long pressed',
    [dropdown('button', ['3', '6', '9'])]),
  card(BILRESA_DEVICE_ID, 'switch_multi_press_multi', 'A button was pressed multiple times',
    [dropdown('button', NINE), dropdown('count', EIGHTEEN)]),
];
