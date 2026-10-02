import { ScheduledTask, type ScheduledTaskConfig } from '@vendure/core';
import { COUNTRY_SYNC_TASK_ID } from './constants';
import { NovaPoshtaService } from './nova-poshta.service';

export function createCountrySyncTask(schedule: ScheduledTaskConfig['schedule']): ScheduledTask {
  return new ScheduledTask({
    id: COUNTRY_SYNC_TASK_ID,
    description: "Write Nova Poshta's country refs into Country.customFields.novaPoshtaCountryRef",
    schedule,
    execute({ injector, scheduledContext }) {
      return injector.get(NovaPoshtaService).syncCountries(scheduledContext);
    },
  });
}
