import type { EtaResult } from '@qevra/contracts';
export interface EtaInput {
  now:Date;peopleAhead:number;durationMinutes:number;sessionOpen:boolean;serviceActive:boolean;waiting:boolean;
  counters:{status:'CALLED'|'SERVING'|null;servingAt:Date|null}[];
}
export interface EtaCalculator { calculate(input:EtaInput):EtaResult; }
export class CounterEtaCalculator implements EtaCalculator {
  calculate(input:EtaInput):EtaResult{
    const base={peopleAhead:input.peopleAhead,calculatedAt:input.now.toISOString()};
    if(!input.waiting)return {...base,estimatedWaitMinutes:null,etaStatus:'UNAVAILABLE'};
    if(!input.sessionOpen || !input.serviceActive || !input.counters.length)return {...base,estimatedWaitMinutes:null,etaStatus:'PAUSED'};
    const duration=input.durationMinutes;
    const slots=input.counters.map(counter=>{
      if(!counter.status)return 0;
      if(counter.status==='CALLED' || !counter.servingAt)return duration;
      const elapsed=Math.max(0,(input.now.getTime()-counter.servingAt.getTime())/60000);
      // Overdue service is uncertain; reserve a small non-zero buffer.
      return Math.max(1,duration-elapsed);
    });
    // Assign each waiting predecessor to the earliest free counter.
    for(let index=0;index<input.peopleAhead;index++){
      let earliest=0;
      for(let slot=1;slot<slots.length;slot++)if(slots[slot]!<slots[earliest]!)earliest=slot;
      slots[earliest]=slots[earliest]!+duration;
    }
    return {...base,estimatedWaitMinutes:Math.ceil(Math.min(...slots)),etaStatus:'AVAILABLE'};
  }
}
