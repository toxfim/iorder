import { useI18n } from 'vue-i18n';
import type { Blocker } from '../domain/action-blockers';

/** The sentences of a button's blockers, in the reader's language. */
export function useBlockerText() {
  const { t } = useI18n();
  const sentence = (blocker: Blocker): string =>
    t(`orders.blocked.reason.${blocker.code}`, blocker.params ?? {});

  return {
    /** Every reason, the first thing to do first: the tooltip and the dialog. */
    texts: (blockers: readonly Blocker[]): string[] => blockers.map(sentence),
    /**
     * The line printed beside the button: the first reason. A running request is not printed (the
     * button spins, and a line that flashes for a second only makes the panel jump).
     */
    note: (blockers: readonly Blocker[]): string | null => {
      const first = blockers[0];
      return first === undefined || first.code === 'BUSY' ? null : sentence(first);
    },
  };
}
