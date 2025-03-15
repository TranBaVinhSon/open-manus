/**
 * Interface for data entries stored in memory
 */
export interface DataEntry {
  stepId: number;
  type: string;
  data: any;
  timestamp: number;
}

/**
 * Memory store for efficiently managing research data with indexing by type and step
 * Using Maps for optimal performance with O(1) lookups
 */
export class MemoryStore {
  // Using Maps instead of Records for better performance and proper key typing
  private dataByType: Map<string, DataEntry[]> = new Map();
  private dataByStepId: Map<number, DataEntry[]> = new Map();
  private allData: DataEntry[] = [];

  /**
   * Add a result to the memory store
   * @param stepId The ID of the step that generated this result
   * @param type The type of operation (search, browser, etc.)
   * @param data The actual result data
   */
  addResult(stepId: number, type: string, data: any): void {
    const entry: DataEntry = {
      stepId,
      type,
      data,
      timestamp: Date.now(),
    };

    // Index by type - Maps provide better key handling than Records
    if (!this.dataByType.has(type)) {
      this.dataByType.set(type, []);
    }
    this.dataByType.get(type)!.push(entry);

    // Index by step ID
    if (!this.dataByStepId.has(stepId)) {
      this.dataByStepId.set(stepId, []);
    }
    this.dataByStepId.get(stepId)!.push(entry);

    // Add to chronological list
    this.allData.push(entry);
  }

  /**
   * Get all results of a specific type
   * @param type The type of operation to filter by
   */
  getResultsByType(type: string): DataEntry[] {
    return this.dataByType.get(type) || [];
  }

  /**
   * Get all results from a specific step
   * @param stepId The ID of the step to get results for
   */
  getResultsByStepId(stepId: number): DataEntry[] {
    return this.dataByStepId.get(stepId) || [];
  }

  /**
   * Get the most recent result of a specific type
   * @param type The type of operation
   */
  getLatestResultOfType(type: string): DataEntry | null {
    const results = this.dataByType.get(type) || [];
    return results.length > 0 ? results[results.length - 1] : null;
  }

  /**
   * Get the most recent results across all types
   * @param limit Maximum number of results to return
   */
  getLatestResults(limit: number = 5): DataEntry[] {
    return [...this.allData]
      .sort((a, b) => b.timestamp - a.timestamp)
      .slice(0, limit);
  }

  /**
   * Get all data in chronological order
   */
  getAllData(): DataEntry[] {
    return this.allData;
  }

  /**
   * Clear data for a specific step
   * @param stepId The ID of the step to clear data for
   */
  clearStepData(stepId: number): void {
    // Remove from step index
    this.dataByStepId.delete(stepId);

    // Remove from type indices
    for (const [type, entries] of this.dataByType.entries()) {
      const filteredEntries = entries.filter(
        (entry) => entry.stepId !== stepId,
      );
      if (filteredEntries.length === 0) {
        this.dataByType.delete(type);
      } else {
        this.dataByType.set(type, filteredEntries);
      }
    }

    // Remove from allData
    this.allData = this.allData.filter((entry) => entry.stepId !== stepId);
  }

  /**
   * Check if there are results for a specific step
   * @param stepId The ID of the step to check
   */
  hasResultsForStep(stepId: number): boolean {
    return this.dataByStepId.has(stepId);
  }

  /**
   * Format research data as context for LLM prompts
   */
  getFormattedContext(): string {
    if (this.allData.length === 0) {
      return 'This is the first step, so there are no previous results.';
    }

    let context = `Progress so far:\n\n`;

    // Include all previous research data with step information
    this.allData.forEach((entry) => {
      context += `Step ${entry.stepId}: ${entry.type} operation\n`;
      context += `Results:\n${JSON.stringify(entry.data, null, 2)}\n\n`;
    });

    return context;
  }

  /**
   * Get a more concise context for LLM prompts with limited token usage
   * @param maxEntries Maximum number of recent entries to include
   */
  getConciseContext(maxEntries: number = 5): string {
    if (this.allData.length === 0) {
      return 'This is the first step, so there are no previous results.';
    }

    let context = `Progress so far (${this.allData.length} total steps, showing last ${Math.min(maxEntries, this.allData.length)}):\n\n`;

    // Get the most recent entries
    const recentEntries = this.getLatestResults(maxEntries);

    // Include recent research data with step information
    recentEntries.forEach((entry) => {
      context += `Step ${entry.stepId}: ${entry.type} operation\n`;

      // For large data, summarize rather than showing everything
      const dataStr = JSON.stringify(entry.data);
      if (dataStr.length > 500) {
        context += `Results: [Large data: ${dataStr.length} chars, showing summary]\n`;
        // Create a summary by selecting top-level properties
        const summary = Object.keys(entry.data)
          .map((key) => {
            const value = entry.data[key];
            if (typeof value === 'string' && value.length > 100) {
              return `${key}: "${value.substring(0, 100)}..."`;
            } else {
              return `${key}: ${JSON.stringify(value)}`;
            }
          })
          .join('\n');
        context += `${summary}\n\n`;
      } else {
        context += `Results:\n${dataStr}\n\n`;
      }
    });

    return context;
  }

  /**
   * Get the number of stored data entries
   */
  get length(): number {
    return this.allData.length;
  }
}
