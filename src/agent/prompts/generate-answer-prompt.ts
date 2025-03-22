export const getGenerateAnswerPrompt = (
  task: string,
  researchData: any[],
): string => {
  return `You are an AI assistant tasked with generating a comprehensive final answer based on the following task and research data.

Task: ${task}

Research Data:
${JSON.stringify(researchData, null, 2)}

Please analyze the research data in the context of the original task. Your answer should:
1. Directly address the goal of the task
2. Synthesize the most relevant findings from the research data
3. Present conclusions that are well-supported by the gathered information
4. Be clear, concise, and actionable
5. Acknowledge any limitations or areas where additional research might be needed

Provide a well-structured response that effectively answers the original task based on all available information.
`;
};
