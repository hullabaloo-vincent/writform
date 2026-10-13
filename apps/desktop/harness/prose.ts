// English prose written for the tests: a few short chapters of a story in
// which every pattern the reports look for occurs a known number of
// times, and plain passages in which none does.

export interface Para {
  text: string;
  /** "chapter" for a chapter heading. */
  heading?: string;
}

const h = (text: string): Para => ({ text, heading: "chapter" });
const p = (text: string): Para => ({ text });

/** A quiet paragraph: nothing in it for any report to remark on. */
export const PLAIN =
  "The harbour lay under a thin mist when Marianne came down the hill. Gulls argued over something on the quay, and a boy she half knew was coiling rope beside the first of the boats. " +
  "She stopped at the wall to watch him work. Nobody else was about so early, which suited her, because the letter in her pocket was not one she wished to explain.";

export const STORY: Para[] = [
  h("The Letter"),
  p(PLAIN),
  p("“You are early,” said the boy. “Did the post come?”"),
  p("“It came.” She did not say more. “Is your father about?”"),
  p("He shook his head and went on with the rope. The rope was wet and heavy, and the rope left marks on his hands that he did not seem to mind."),
  p("She walked to the end of the quay. She looked at the water. She thought about the letter. She did not open it."),
  h("The Garden"),
  p("Mr. Ashworth kept his garden as other men keep accounts. Every bed was ruled and every path was swept, and at the end of the day he walked the length of it with his hands behind his back, counting what had come up and what had not, until the light went and the housekeeper called him in to a supper he ate without noticing what it was."),
  p("At the end of the day he was content. At the end of the day he wanted nothing more than this."),
  p("“Thaddeus,” said Mrs. Penhallow from the gate. “There is a girl here with a letter.”"),
  p("“Then she had better come in,” he said."),
  h("The Answer"),
  p("The lantern stood on the table between them. Marianne laid the letter beside the lantern and waited while he read it, and the lantern hissed in the silence, and nobody moved."),
  p("He read it twice. He folded it once. He put it down."),
  p("“I see,” said Mr. Ashworth at last. “And you walked here with this?”"),
  p("“I did.”"),
  h("The Road"),
  p("Morning came grey over the fields. " + PLAIN.replace("harbour", "road").replace("quay", "verge")),
  p("They did not speak of it again that day, and by evening the house had gone back to its habits as if nothing had been said."),
];

/** The same story as a manuscript's blocks would be read. */
export const storyText = (): { text: string; heading: string | null }[] => STORY.map((para) => ({ text: para.text, heading: para.heading ?? null }));
