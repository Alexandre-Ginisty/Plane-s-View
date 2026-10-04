/**
 * Translated names for the things the app keeps as ids: camera views, flight
 * phases, link grades, feed states. The ids stay English and stable (they are
 * keys in code and in tests); only what is shown is translated, here.
 */

import { t, type MessageKey } from '@/i18n/index.svelte';
import type { FlightPhase } from '@/state/phase';
import type { NetworkGrade } from '@/net/quality/profile';

export function cameraLabel(id: string): string {
  return t(`cam.${id}` as MessageKey);
}

export function cameraHint(id: string): string {
  return t(`cam.${id}Hint` as MessageKey);
}

export function groupLabel(id: string): string {
  return t(`cam.group.${id}` as MessageKey);
}

export function groupHint(id: string): string {
  return t(`cam.group.${id}Hint` as MessageKey);
}

export function phaseLabel(phase: FlightPhase): string {
  return t(`phase.${phase}` as MessageKey);
}

export function gradeLabel(grade: NetworkGrade): string {
  return t(`net.${grade}.label` as MessageKey);
}

export function gradeAdvice(grade: NetworkGrade): string {
  return t(`net.${grade}.advice` as MessageKey);
}
