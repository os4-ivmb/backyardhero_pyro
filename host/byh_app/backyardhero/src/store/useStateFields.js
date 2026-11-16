import { useMemo } from 'react';
import { useShallow } from 'zustand/react/shallow';
import useStateAppStore from './useStateAppStore';

// Flatten subscriptions before reconstructing the state shape used by panels.
export default function useStateFields(fields) {
  const values = useStateAppStore(useShallow((state) => fields.map((field) =>
    field.split('.').reduce((value, key) => value?.[key], state.stateData))));
  const signature = fields.join(',');
  return useMemo(() => {
    const result = {};
    signature.split(',').forEach((field, index) => {
      const keys = field.split('.');
      let target = result;
      keys.slice(0, -1).forEach((key) => { target = target[key] ||= {}; });
      target[keys[keys.length - 1]] = values[index];
    });
    return result;
  }, [signature, values]);
}
