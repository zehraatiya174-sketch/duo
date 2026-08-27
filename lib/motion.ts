import type { Transition, Variants } from 'framer-motion';

/**
 * Shared motion vocabulary.
 *
 * Every animation in the app is one of these, so the whole product moves with
 * the same weight. Two rules hold throughout: only `opacity` and `transform`
 * are animated — never layout properties, which would thrash on every frame —
 * and nothing runs longer than ~320ms, because a chat is a tool, not a title
 * sequence.
 *
 * `framer-motion` disables these automatically when the OS asks for reduced
 * motion, provided `MotionConfig reducedMotion="user"` wraps the tree (see
 * `components/providers/app-providers.tsx`).
 */

/** Springs, not durations — a spring survives interruption without a jump. */
export const springSoft: Transition = {
  type: 'spring',
  stiffness: 320,
  damping: 34,
  mass: 0.9,
};

const springSnappy: Transition = {
  type: 'spring',
  stiffness: 460,
  damping: 32,
  mass: 0.7,
};

/** Plain cross-fade for things that should not appear to move. */
export const fade: Variants = {
  hidden: { opacity: 0 },
  visible: { opacity: 1, transition: { duration: 0.18, ease: 'easeOut' } },
  exit: { opacity: 0, transition: { duration: 0.14, ease: 'easeIn' } },
};

/** The default entrance: a short rise with the fade. */
export const fadeUp: Variants = {
  hidden: { opacity: 0, y: 12 },
  visible: { opacity: 1, y: 0, transition: springSoft },
  exit: { opacity: 0, y: 6, transition: { duration: 0.14, ease: 'easeIn' } },
};

/** For things that own a point on screen — overlays, popovers, tray chips. */
export const scaleIn: Variants = {
  hidden: { opacity: 0, scale: 0.94 },
  visible: { opacity: 1, scale: 1, transition: springSnappy },
  exit: { opacity: 0, scale: 0.96, transition: { duration: 0.12, ease: 'easeIn' } },
};

/**
 * Container variant. Children declared with `staggerItem` inherit `hidden` /
 * `visible` from the parent, so a list animates in sequence without any child
 * needing its own `initial`/`animate`.
 *
 * A factory rather than a constant because the right gap depends on how many
 * children there are: a dashboard of ten panels needs a tighter interval than a
 * three-field form, or the last one arrives long after the page looks settled.
 */
export function stagger(childDelay = 0.045): Variants {
  return {
    hidden: {},
    visible: {
      transition: { staggerChildren: childDelay, delayChildren: childDelay },
    },
  };
}

export const staggerItem: Variants = {
  hidden: { opacity: 0, y: 10 },
  visible: { opacity: 1, y: 0, transition: springSoft },
};

/**
 * A message landing in the timeline.
 *
 * Own messages slide in from the sending edge and the peer's from the opposite
 * one, which makes authorship legible before the bubble colour is even read.
 * The offset is small on purpose: at 24px it reads as an animation, at 8px it
 * reads as the message arriving.
 */
export function messageEnter(mine: boolean): Variants {
  return {
    hidden: { opacity: 0, y: 8, x: mine ? 8 : -8, scale: 0.985 },
    visible: {
      opacity: 1,
      y: 0,
      x: 0,
      scale: 1,
      transition: springSnappy,
    },
    exit: { opacity: 0, scale: 0.985, transition: { duration: 0.12, ease: 'easeIn' } },
  };
}
