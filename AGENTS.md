# Agent instructions

## Engineering preferences

### Code organization

- Make file and directory placement communicate domain and responsibility.
- Prefer clear responsibility boundaries over a flat structure. A meaningful subfolder is justified even when it initially contains only one file.
- Apply the same organizational principles across related features. Do not isolate one feature differently without a concrete reason.
- Keep distinct responsibilities separate, but do not introduce layers, interfaces, or files without a clear purpose.
- Remove unused code rather than retaining it for hypothetical future use.

### Comments

- Use visually distinct section comments in the form `// --- Section title ---` to mark groups of related responsibilities and make larger files easy to scan. Label meaningful groups, not every method or statement. Use the equivalent comment syntax in other languages.
- Keep explanatory comments local and purposeful. Explain non-obvious intent, constraints, or tradeoffs—not self-evident behavior or implementation details owned by other components.
- Write short comments in plain language that make the code easier to understand. Avoid jargon and abstract wording when simpler words work.

### Shared abstractions

- Give interchangeable implementations a small, consistent contract.
- Keep specialized behavior within the relevant implementation. Do not force genuinely different protocols or features into a universal abstraction.

### Technical judgment

- Evaluate existing implementations rather than treating them as the default architecture.
- For external integrations, consult current official documentation and assess compatibility with the project's runtime and requirements.
- Explain consequential tradeoffs and distinguish verified facts from assumptions.
- Challenge proposed decisions when there is a concrete concern, and offer a better alternative. Revisit a resolved disagreement only when new evidence or a materially different tradeoff warrants it.
