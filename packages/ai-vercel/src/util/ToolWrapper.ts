import { Tool } from "ai";
import { Schema, z } from "zod/v3";

type Parameters = z.ZodTypeAny | Schema<any>;

export type ToolWrapper = <
  TParams extends Parameters = any,
  TResult = any,
  ToolType extends Tool<TParams, TResult> = Tool<TParams, TResult>,
>(
  t: ToolType
) => ToolType;
