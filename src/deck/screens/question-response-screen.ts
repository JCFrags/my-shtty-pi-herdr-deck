import type { RenderedSurface } from "../screen-types.js";
import { SurfaceBuilder } from "../geometry.js";
import {
  applyQuestionRecommendation,
  questionResponseValid,
  type OverlayState,
} from "../overlay-screen.js";

export interface QuestionResponseScreenOptions {
  width: number;
  state: Extract<OverlayState, { kind: "question-response" }>;
  onToggle(optionId: string): void;
  onRecommendation(): void;
  onSubmit(): void;
  onCancel(): void;
  onDismiss(): void;
  onRetry(): void;
}

export function renderQuestionResponseScreen(
  options: QuestionResponseScreenOptions,
): RenderedSurface {
  const { state } = options;
  const surface = new SurfaceBuilder(options.width);
  surface.addLine(
    `${state.question.source === "signals" ? "BOARD-ANSWER: SIGNALS" : "ANSWER: QUESTION"} RESPONSE`,
  );
  surface.addLine(state.question.prompt);
  if (state.question.terminal)
    surface.addLine("This question is no longer answerable.");
  for (const option of state.question.options) {
    const selected = state.selectedOptionIds.includes(option.id);
    surface.addRow(
      `question:option:${option.id}`,
      `${selected ? "[x]" : "[ ]"} ${option.label}${option.description ? ` — ${option.description}` : ""}`,
      () => options.onToggle(option.id),
    );
  }
  if (state.question.allowFreeform || state.question.responseKind === "text")
    surface.addLine(`Text: ${state.text}█`);
  if (
    state.question.recommendedOptionIds.length > 0 ||
    state.question.recommendedText
  )
    surface.addButtons([
      {
        id: "question:recommendation",
        label: "Recommendation",
        disabled: state.pending === true,
        activate: options.onRecommendation,
      },
    ]);
  if (state.pending) surface.addLine("Request pending…");
  if (state.error) surface.addLine(`! ${state.error}`);
  surface.addButtons([
    {
      id: "question:cancel",
      label: "Cancel",
      activate: options.onCancel,
    },
    ...(state.question.dismissible
      ? [
          {
            id: "question:dismiss",
            label: "Dismiss",
            disabled: state.pending === true,
            activate: options.onDismiss,
          },
        ]
      : []),
    ...(state.question.retryableDelivery && state.question.answerId
      ? [
          {
            id: "question:retry",
            label: "Retry delivery",
            disabled: state.pending === true,
            activate: options.onRetry,
          },
        ]
      : []),
    {
      id: "question:submit",
      label: "Submit Answer",
      disabled:
        state.pending === true ||
        state.question.terminal ||
        !questionResponseValid(state),
      activate: options.onSubmit,
    },
  ]);
  return surface.finish();
}

export { applyQuestionRecommendation };
