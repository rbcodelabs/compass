"use client"

import { useRef, useState } from "react"
import { PlusIcon, Trash2Icon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"

type Question = { id: number }

const placeholders = [
  "Tell me about the last time you…",
  "What was the most difficult part?",
  "What did you do next?",
]

export function QuestionBuilder() {
  const nextId = useRef(2)
  const [questions, setQuestions] = useState<Question[]>([{ id: 1 }])

  function addQuestion() {
    setQuestions((current) => [...current, { id: nextId.current++ }])
  }

  function removeQuestion(id: number) {
    setQuestions((current) => current.filter((question) => question.id !== id))
  }

  return (
    <fieldset className="space-y-3">
      <div className="space-y-1">
        <legend className="text-sm font-medium">Discussion guide</legend>
        <p className="text-sm text-text-muted">
          Add what you want Compass to cover. It will ask these one at a time
          and follow up naturally.
        </p>
      </div>

      <div className="space-y-2">
        {questions.map((question, index) => (
          <div key={question.id} className="flex items-center gap-2">
            <span
              aria-hidden="true"
              className="flex size-7 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-medium text-text-muted"
            >
              {index + 1}
            </span>
            <Input
              aria-label={`Question ${index + 1}`}
              name="guide"
              placeholder={placeholders[index] ?? "Add another question…"}
              required
            />
            <Button
              aria-label={`Remove question ${index + 1}`}
              disabled={questions.length === 1}
              onClick={() => removeQuestion(question.id)}
              size="icon"
              type="button"
              variant="ghost"
            >
              <Trash2Icon />
            </Button>
          </div>
        ))}
      </div>

      <Button onClick={addQuestion} type="button" variant="outline">
        <PlusIcon data-icon="inline-start" />
        Add question
      </Button>
    </fieldset>
  )
}
