import type { TrackedDecisionAnswer, TrackedDecisionPacketQuestion } from "@/lib/tracked-decision-types"

const WRAP = "break-words [overflow-wrap:anywhere]"

/** Each answered question with the option chosen, for the decided banner and lists. */
export function DecisionAnswerList({ answers, className }: { answers: TrackedDecisionAnswer[]; className?: string }) {
  if (answers.length === 0) return null
  return <ol aria-label="Answers" className={`min-w-0 space-y-2 ${className ?? ""}`}>
    {answers.map((answer) => <li key={answer.questionIndex} className="min-w-0 rounded-md border bg-background/60 p-3">
      <span className={`block text-xs text-muted-foreground ${WRAP}`}>{answer.questionIndex + 1}. {answer.question}</span>
      <span className={`mt-0.5 block font-medium text-foreground ${WRAP}`}><span aria-hidden className="mr-1 text-muted-foreground">→</span>{answer.chosenOption}</span>
    </li>)}
  </ol>
}

/** The questions and their options as offered, for viewers who cannot decide. */
export function DecisionQuestionList({ questions }: { questions: TrackedDecisionPacketQuestion[] }) {
  if (questions.length === 0) return null
  return <div className="space-y-2">
    <p className="font-medium text-foreground">Questions asked</p>
    <ol className="space-y-2">
      {questions.map((question, index) => <li key={index} className="min-w-0 rounded-md border bg-background p-3">
        <span className={`block font-medium text-foreground ${WRAP}`}>{index + 1}. {question.header ? `[${question.header}] ` : ""}{question.question}</span>
        <ul className="mt-1 space-y-1">
          {question.options.map((option) => <li key={option.label} className={`min-w-0 ${WRAP}`}>• {option.label}{option.description ? ` — ${option.description}` : ""}</li>)}
        </ul>
      </li>)}
    </ol>
  </div>
}
