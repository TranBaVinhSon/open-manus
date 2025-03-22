export const getBrowserStepPlanningPrompt = (
  goal: string,
  currentUrl: string,
  previousSteps: any[],
) => {
  return `
Current URL: ${currentUrl} with the goal being "${goal}".
⚠️ IMPORTANT: Review previous steps and their results. If these results satisfy the original goal, return CLOSE to prevent infinite loops.
${
  previousSteps && previousSteps.length > 0
    ? `
Last step taken:
- Action: ${previousSteps[previousSteps.length - 1].text}
- Reasoning: ${previousSteps[previousSteps.length - 1].reasoning}
- Method Used: ${previousSteps[previousSteps.length - 1].method}
- Instruction: ${previousSteps[previousSteps.length - 1].instruction}
${
  previousSteps[previousSteps.length - 1].result
    ? `
- Result: ${typeof previousSteps[previousSteps.length - 1].result === 'string' ? (previousSteps[previousSteps.length - 1].result.length > 100 ? previousSteps[previousSteps.length - 1].result.substring(0, 100) + '...' : previousSteps[previousSteps.length - 1].result) : 'Data extracted'}`
    : ''
}`
    : ''
}

Determine the immediate next step to take to achieve the goal.

Important guidelines:
1. Break down complex actions into individual atomic steps.
2. Choose the appropriate method based on the task:
   - Use HTML: For getting the complete page source (SEO audits, page analysis). No instruction needed
   - Use EXTRACT: For getting specific elements with a clear instruction (prices, titles, specific content)
   - Use OBSERVE: For analyzing visible elements and their properties
   - Use ACT: For clicking, typing, or other interactions
   - Use WAIT: For waiting specific milliseconds
   - Use NAVBACK: For going back to previous page
   - Use GOTO: For navigating to a specific URL
   - Use AI_HANDLE: For tasks that can be handled by AI without browser interaction (analysis, summarization, etc.)
   - Use CLOSE when:
    - The goal has been achieved
    - You have collected all necessary information
    - No more browser interaction is needed
4. Best practices:
   - Break down complex tasks into smaller, atomic steps
     - Example of ACT method:
      - DON'T: log in and purchase the first item
      - DO:
        - click the login button
        - click on the first item
        - click the purchase button

   - Don't use broad or ambiguous instructions like "find something interesting on the page"
   - Avoid combining actions such as "fill out the form and submit it"
   - Avoid perform high-level planning or reasoning such as "book the cheapest flight available"

MOST IMPORTANT: After each step, evaluate if the goal "${goal}" has been achieved based on the results of the current and previous steps. If it has, return CLOSE. This is critical to prevent infinite loops.
  
  
  `;
};
