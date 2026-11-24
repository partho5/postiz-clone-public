// AI video editing (ai.video-editing), planner core: the client check (tracing card L4). The validator makes a plan
// valid for the contract; this asks the other question, "will the phone draw it as intended?": every asset, zone, look,
// effect and entry the plan names exists, every item is inside the video with a real range, no two overlays show at once,
// a text fits its look and the frame, the captions stress words that exist, the facecam is not covered and the plan's
// duration is the one its cuts give. It returns findings as data and never changes the plan. A finding carries codes,
// item ids and counts only: never the text of an overlay. Pure functions, no Nest, Prisma or network import (the check
// that an asset's URL answers is a call, so the service makes it and adds `asset_unreachable` with `unreachableAssets`).
import {
  EditRequestOutput,
  OUTPUTS,
  Plan,
  PlanAsset,
  PlanItem,
  TextLook,
  ZONES,
  ZoneId,
} from '../contract/edit.contract';
import { ENTRY_MOTIONS, EXIT_DIRS, EXIT_MOTIONS, HOLD_MOTIONS } from '../contract/edit.motions';
import { EFFECTS, effectById } from '../contract/edit.registry';
import { lookUsable, requiredFeatures, textLookById } from '../contract/edit.styles';
import {
  OVERLAY_SIZE,
  boxesOverlap,
  facecamBox,
  facecamKeysIn,
  graphemes,
  lookGrowth,
  overlayBox,
  textLines,
  textUnits,
  wordCount,
} from './edit.geometry';
import { MAX_TEXT_GRAPHEMES, isOverlay, overlaps } from './edit.rules';
import { buildMap } from './edit.timeline';

// How serious a finding is: `error` is a plan the phone cannot draw as it stands (see `isUnusable`), `warning` a plan it
// draws with a defect, `info` a fact the trace keeps.
export type CheckSeverity = 'error' | 'warning' | 'info';

// The stable codes of the findings.
export type CheckCode =
  | 'asset_unresolved'
  | 'unknown_zone'
  | 'unknown_style'
  | 'style_not_in_capabilities'
  | 'unknown_effect'
  | 'unknown_entry'
  | 'unknown_motion'
  | 'out_of_range'
  | 'bad_range'
  | 'layer_overlap'
  | 'text_may_wrap'
  | 'text_too_wide'
  | 'text_over_cap'
  | 'text_cannot_fit'
  | 'emphasis_out_of_range'
  | 'no_facecam_track'
  | 'facecam_keepout'
  | 'duration_mismatch'
  | 'asset_unreachable';

// One finding: its code, the plan item it is about (`*` for the plan, `captions` for the captions), how serious it is and
// a short detail made of codes and counts.
export interface CheckResult {
  code: CheckCode;
  item_id: string;
  severity: CheckSeverity;
  detail: string;
}

// What the check reads: the plan and its asset list; the request's video size and outputs (for the facecam check); the
// source duration (for the duration check); the number of output words (for the emphasis check). What is not given
// skips the check that needs it.
export interface ClientCheckInput {
  plan: Plan;
  assets: PlanAsset[];
  video?: { width: number; height: number };
  outputs?: EditRequestOutput[];
  source_duration_ms?: number;
  word_count?: number;
  // The video's language, for counting the words and graphemes of a text.
  language?: string;
  // What the phone listed (card S9): a look it did not list, or one needing a feature it did not list, is a finding. Not
  // given: no such check.
  capabilities?: { text_styles: string[]; text_features?: string[] | null };
  // The look table the check reads; the shipped `TEXT_LOOKS` unless a spec brings its own.
  looks?: TextLook[];
}

// How much of a text each look takes before the phone may wrap or shrink it. The size share is the contract's
// (`OVERLAY_SIZE.char_w` of the output width per character, one line at most `max_w` wide); the padding of a look
// (`pad_chars`: its background, stroke, shadow or glow, as characters) is added to the width. The maxima are conservative,
// below what one line holds: a look with a pill behind it takes the least, as its padding is the largest. Every look of
// `TEXT_LOOKS` has an entry.
export const TEXT_FIT: Record<string, { max_chars: number; max_words: number; pad_chars: number }> = {
  label_pill: { max_chars: 18, max_words: 3, pad_chars: 1.5 },
  sticker: { max_chars: 22, max_words: 4, pad_chars: 1 },
  '3d': { max_chars: 18, max_words: 4, pad_chars: 0.5 },
  glow: { max_chars: 22, max_words: 4, pad_chars: 1 },
  gradient: { max_chars: 22, max_words: 4, pad_chars: 0.5 },
  highlighter: { max_chars: 24, max_words: 4, pad_chars: 0.5 },
  // the ten looks of card S8: each has a box with padding and a border, so the padding is `lookExtent(look).x` in characters
  // (`s` is `OVERLAY_SIZE.s_w / char_w` = 1.53 characters), rounded up, and the maxima are the label pill's
  neon_box: { max_chars: 16, max_words: 3, pad_chars: 2.2 },
  pill_ring: { max_chars: 18, max_words: 3, pad_chars: 2 },
  gradient_block: { max_chars: 18, max_words: 3, pad_chars: 2 },
  tilt_sticker: { max_chars: 18, max_words: 3, pad_chars: 2 },
  solid_round: { max_chars: 18, max_words: 3, pad_chars: 1.7 },
  pastel_pill: { max_chars: 18, max_words: 3, pad_chars: 1.8 },
  flat_rect: { max_chars: 18, max_words: 3, pad_chars: 1.8 },
  yellow_bold: { max_chars: 18, max_words: 3, pad_chars: 1.8 },
  dark_accent: { max_chars: 18, max_words: 3, pad_chars: 1.8 },
  coral_pill: { max_chars: 18, max_words: 3, pad_chars: 2 },
};

// The codes that make a plan unusable: the phone cannot draw it as it stands. Everything else is a warning.
const BLOCKING: CheckCode[] = [
  'unknown_effect',
  'unknown_style',
  'style_not_in_capabilities',
  'unknown_zone',
  'bad_range',
  'asset_unresolved',
  'text_over_cap',
  'text_cannot_fit',
];

// The entries an effect may animate with: the registry's own (`params.entry`, with `draw` and `count_up`) and the motion table's.
const ENTRIES = new Set([
  ...EFFECTS.map((e) => e.default_params.entry).filter((v): v is string => typeof v === 'string'),
  ...ENTRY_MOTIONS.map((m) => m.id),
]);

// The hold and exit motions and the exit sides a plan may name (`params.hold`, `params.exit`, `params.exit_dir`).
const MOTION_VALUES: Record<string, Set<string>> = {
  hold: new Set(HOLD_MOTIONS.map((m) => m.id)),
  exit: new Set(EXIT_MOTIONS.map((m) => m.id)),
  exit_dir: new Set(EXIT_DIRS),
};

// Whether a value is a number the plan can hold (finite).
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

// A finding.
const found = (code: CheckCode, item_id: string, severity: CheckSeverity, detail: string): CheckResult => ({
  code,
  item_id,
  severity,
  detail,
});

// The findings of one text overlay about its fit: more graphemes than the cap or a text the phone cannot lay out (both
// errors), too long for its look, and too wide for the frame.
const textFit = (
  item: PlanItem,
  text: string,
  style: string,
  ratios: Array<keyof typeof OUTPUTS>,
  language?: string,
  look?: TextLook
): CheckResult[] => {
  const out: CheckResult[] = [];
  const chars = graphemes(text.trim()).length;
  const words = wordCount(text, language);
  const units = textUnits(text);
  if (chars > MAX_TEXT_GRAPHEMES) {
    out.push(found('text_over_cap', item.id, 'error', `chars=${chars} max_chars=${MAX_TEXT_GRAPHEMES}`));
  }
  if (textLines(text, language, lookGrowth(look).w) > OVERLAY_SIZE.max_lines) {
    out.push(
      found('text_cannot_fit', item.id, 'error', `chars=${chars} width_units=${Math.round(units)} words=${words}`)
    );
  }
  const fit = TEXT_FIT[style];
  if (!fit) return out;
  if (chars > fit.max_chars || words > fit.max_words) {
    out.push(
      found(
        'text_may_wrap',
        item.id,
        'warning',
        `style=${style} chars=${chars} max_chars=${fit.max_chars} words=${words} max_words=${fit.max_words}`
      )
    );
  }
  // one word cannot wrap; more than one goes on 2 lines at most
  const lines = words > 1 ? 2 : 1;
  const safe = Math.min(...ratios.map((r) => OUTPUTS[r].safe.x1 - OUTPUTS[r].safe.x0));
  const width = (units + fit.pad_chars) * OVERLAY_SIZE.char_w;
  if (width > lines * safe) {
    out.push(
      found(
        'text_too_wide',
        item.id,
        'warning',
        `style=${style} chars=${chars} width_pct=${Math.round(width * 100)} limit_pct=${Math.round(lines * safe * 100)}`
      )
    );
  }
  return out;
};

// Checks a plan for what the phone may draw badly; see the header. The plan is not changed. Findings come in item
// order, then the plan's own findings.
export const clientCheck = (input: ClientCheckInput): CheckResult[] => {
  const { plan } = input;
  const out: CheckResult[] = [];
  const assetsById = new Map(input.assets.map((a) => [a.id, a]));
  const outputs = input.outputs ?? [];
  const ratios = outputs.length ? outputs.map((o) => o.ratio) : (Object.keys(OUTPUTS) as Array<keyof typeof OUTPUTS>);
  const total = plan.video.output_duration_ms;
  const overlays: PlanItem[] = [];

  for (const item of plan.items) {
    const effect = effectById(item.effect);
    if (!effect) {
      out.push(found('unknown_effect', item.id, 'error', 'in=item'));
    }

    if (!finite(item.start_ms) || !finite(item.end_ms) || item.start_ms >= item.end_ms) {
      out.push(found('bad_range', item.id, 'error', `start_ms=${item.start_ms} end_ms=${item.end_ms}`));
    } else if (item.start_ms < 0 || item.end_ms > total) {
      out.push(found('out_of_range', item.id, 'warning', `start_ms=${item.start_ms} end_ms=${item.end_ms} output_ms=${total}`));
    }

    const entry = item.params?.entry;
    if (typeof entry === 'string' && !ENTRIES.has(entry)) {
      out.push(found('unknown_entry', item.id, 'warning', `entry_chars=${entry.length}`));
    }
    for (const [key, allowed] of Object.entries(MOTION_VALUES)) {
      const value = item.params?.[key];
      if (value !== undefined && !allowed.has(String(value))) {
        out.push(found('unknown_motion', item.id, 'warning', `param=${key} value_chars=${String(value).length}`));
      }
    }

    const overlay = isOverlay(item);
    const zone = item.position?.zone;
    const zoneKnown = typeof zone === 'string' && zone in ZONES;
    if (overlay && !zone) {
      out.push(found('unknown_zone', item.id, 'error', 'zone=missing'));
    } else if (zone !== undefined && !zoneKnown) {
      out.push(found('unknown_zone', item.id, 'error', `zone_chars=${String(zone).length}`));
    }

    const component = item.component;
    if (component?.type === 'styled_text') {
      const look = textLookById(component.style_preset, input.looks);
      if (!look) {
        out.push(found('unknown_style', item.id, 'error', `style_chars=${String(component.style_preset).length}`));
      } else if (!lookUsable(look, input.capabilities)) {
        const features = input.capabilities?.text_features ?? [];
        out.push(
          found(
            'style_not_in_capabilities',
            item.id,
            'error',
            `style=${look.id} listed=${input.capabilities?.text_styles.includes(look.id) ? 1 : 0} missing_features=${requiredFeatures(look).filter((f) => !features.includes(f)).length}`
          )
        );
      } else {
        out.push(...textFit(item, String(component.text ?? ''), component.style_preset, ratios, input.language, look));
      }
    } else if (component && !assetsById.has(component.asset_id)) {
      out.push(found('asset_unresolved', item.id, 'error', 'in=component'));
    }
    if (item.sound && assetsById.get(item.sound.id)?.kind !== 'sound') {
      out.push(found('asset_unresolved', item.id, 'warning', 'in=sound'));
    }

    // the facecam: an overlay over the circle in any output it shows in
    if (overlay && zoneKnown && input.video && outputs.length && plan.facecam_track.length) {
      const shape =
        component?.type === 'styled_text'
          ? {
              type: 'text' as const,
              text: String(component.text ?? ''),
              language: input.language,
              look: textLookById(component.style_preset, input.looks),
            }
          : { type: 'icon' as const };
      const keys = facecamKeysIn(plan.facecam_track, item.start_ms, item.end_ms);
      const hit = outputs
        .filter((o) => {
          const box = overlayBox(shape, zone as ZoneId, o);
          return keys.some((k) => {
            const face = facecamBox(k, input.video!, o);
            return !!face && boxesOverlap(box, face);
          });
        })
        .map((o) => o.ratio);
      if (hit.length) {
        out.push(found('facecam_keepout', item.id, 'warning', `ratios=${hit.join(',')}`));
      }
    }

    if (overlay && finite(item.start_ms) && finite(item.end_ms)) {
      const clash = overlays.find((o) => overlaps(o, item));
      if (clash) {
        out.push(found('layer_overlap', item.id, 'warning', `with=${clash.id}`));
      }
      overlays.push(item);
    }
  }

  // the captions
  const caption = effectById(plan.captions.effect);
  if (!caption || caption.layer !== 'caption') {
    out.push(found('unknown_effect', 'captions', 'error', 'in=captions'));
  }
  if (input.word_count !== undefined) {
    const bad = plan.captions.emphasis_words.filter((i) => !Number.isInteger(i) || i < 0 || i >= input.word_count!);
    if (bad.length) {
      out.push(found('emphasis_out_of_range', 'captions', 'warning', `bad=${bad.length} of=${plan.captions.emphasis_words.length} words=${input.word_count}`));
    }
  }

  // the plan
  if (!plan.facecam_track.length) {
    out.push(found('no_facecam_track', '*', 'info', 'keys=0'));
  }
  if (input.source_duration_ms !== undefined) {
    const mapped = buildMap(input.source_duration_ms, plan.structure.cuts, plan.structure.speed_segments).output_duration_ms;
    if (Math.abs(mapped - total) > 1) {
      out.push(found('duration_mismatch', '*', 'warning', `plan_ms=${total} timeline_ms=${mapped}`));
    }
  }
  return out;
};

// Whether the findings make the plan unusable: the phone cannot draw it as it stands (an effect, look, zone or asset it
// names does not exist, or an item has no real time range). Warnings never do.
export const isUnusable = (results: CheckResult[]) =>
  results.some((r) => r.severity === 'error' && BLOCKING.includes(r.code));

// What a probe of one asset's URL found: whether it answered with the kind of file it should be.
export interface AssetProbe {
  id: string;
  ok: boolean;
  // the HTTP status, when the server answered
  status?: number;
  // `unreachable` (no answer in time, or no usable URL), `bad_status` (not 200) or `bad_content_type`
  reason_code?: 'unreachable' | 'bad_status' | 'bad_content_type';
}

// The `asset_unreachable` findings of a list of probes, one per asset that did not answer as it should. The plan's items
// that use the asset are not named: the finding is about the asset (its id).
export const unreachableAssets = (probes: AssetProbe[]): CheckResult[] =>
  probes
    .filter((p) => !p.ok)
    .map((p) => found('asset_unreachable', p.id, 'warning', `reason=${p.reason_code ?? 'unreachable'} status=${p.status ?? 0}`));
