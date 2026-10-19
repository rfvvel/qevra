import {z} from 'zod';
export const analyticsQuerySchema=z.object({
  range:z.enum(['TODAY','LAST_7_DAYS','LAST_30_DAYS']).default('TODAY'),
  branchId:z.string().uuid().optional(),serviceId:z.string().uuid().optional(),
}).strict();
export type AnalyticsQuery=z.infer<typeof analyticsQuerySchema>;
export interface AnalyticsMetrics {
  joined:number; completed:number; cancelled:number; noShow:number;
  averageWaitMinutes:number|null; averageServiceMinutes:number|null;
  waitSamples:number; serviceSamples:number;
}
export interface AnalyticsGroup extends AnalyticsMetrics {id:string;name:string;branchId?:string;}
export interface AnalyticsDashboard {
  generatedAt:string;range:AnalyticsQuery['range'];
  branches:{id:string;name:string;timezone:string;from:string;to:string}[];
  services:{id:string;name:string;branchId:string}[];
  summary:AnalyticsMetrics;
  live:{waiting:number;called:number;serving:number};
  volume:{hour:number;joined:number}[];
  busiestHour:{hour:number;joined:number}|null;
  byService:AnalyticsGroup[];byBranch:AnalyticsGroup[];
}
