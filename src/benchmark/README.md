# GAIA Benchmark Runner

This tool automatically runs the AI agent through the GAIA benchmark tasks, evaluates its performance, and generates a detailed report.

## What is GAIA?

GAIA (Generalized AI Agent benchmark) is a standardized benchmark for evaluating AI assistants across diverse tasks that require fundamental abilities like reasoning, multi-modality handling, web browsing, and tool-use proficiency. The benchmark consists of 466 questions spanning different complexity levels, with answers validated based on factual correctness.

## How to Run

Run the entire benchmark (this will take a long time):

```bash
yarn benchmark
```

Run with a limited number of tasks (for testing):

```bash
yarn benchmark -l 5  # Run only 5 tasks
```

Show help information:

```bash
yarn benchmark --help
```

## Results

After running the benchmark, a JSON file will be created in the project root directory with the format `benchmark-{timestamp}.json`. This file contains:

- Overall metrics (accuracy, execution time)
- Individual results for each task
- Comparison between expected and actual answers

## Metrics Explained

The benchmark calculates the following metrics:

1. **Accuracy**: Percentage of correctly answered questions
2. **Execution Time**: Average time taken to complete each task
3. **Success by Level**: Performance breakdown by GAIA task difficulty levels

## Answer Evaluation

Answers are evaluated using a similarity-based approach:

- Exact matches are given a score of 1.0
- Substring matches score 0.8
- Numerical answers within 1% of each other score 0.9
- Other answers use Jaccard similarity on words

An answer is considered correct if its similarity score is above 0.8.

## Implementation Details

The benchmark:

1. Reads tasks from the GAIA metadata.jsonl file
2. Executes each task using the AI agent
3. Extracts the final answer from the agent's output
4. Compares it to the expected answer
5. Calculates accuracy and performance metrics
6. Generates a detailed report

## Limitations

- The current implementation doesn't handle multi-modal inputs properly (images, audio, etc.)
- Some task types may require manual validation
- The answer extraction might not capture the exact answer in all cases
