import type { Player } from '@cutline/engine';
import { usePlayhead } from './store';

/**
 * Connects UI controls (timeline, keyboard) to the single preview Player
 * instance owned by the Preview component.
 */
let player: Player | null = null;

export function setPlayer(p: Player | null): void {
  player = p;
}

export function seek(t: number): void {
  const time = Math.max(0, t);
  usePlayhead.getState().setTime(time);
  player?.seek(time);
}

export function togglePlay(): void {
  void player?.toggle();
}

export function pause(): void {
  player?.pause();
}

export function currentTime(): number {
  return usePlayhead.getState().time;
}
