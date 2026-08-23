// OPUS B owns. Pure data, DOM-free. Schema: ARCHITECTURE.md §5 "Material".
// Seed values from Fable — tune freely, but materials MUST differ physically.

export const MATERIALS = {
  timber: {
    id: 'timber', name: 'Timber', color: '#c8954a', darkColor: '#8a6023',
    costPerMeter: 16, massPerMeter: 6, thickness: 0.35, stiffness: 0.85,
    tensionLimit: 0.035, compressionLimit: 0.03,
    tensionOnly: false, sealing: true,
    minLength: 0.5, maxLength: 4.5,
  },
  steel: {
    id: 'steel', name: 'Steel', color: '#9fb2c4', darkColor: '#5c6b7a',
    costPerMeter: 55, massPerMeter: 20, thickness: 0.25, stiffness: 0.98,
    tensionLimit: 0.06, compressionLimit: 0.045,
    tensionOnly: false, sealing: true,
    minLength: 0.5, maxLength: 6,
  },
  concrete: {
    id: 'concrete', name: 'Concrete', color: '#b9c4cc', darkColor: '#77828b',
    costPerMeter: 70, massPerMeter: 55, thickness: 0.7, stiffness: 1.0,
    tensionLimit: 0.008, compressionLimit: 0.1,
    tensionOnly: false, sealing: true,
    minLength: 0.5, maxLength: 3.5,
  },
  cable: {
    id: 'cable', name: 'Cable', color: '#e8d44d', darkColor: '#9a8c2a',
    costPerMeter: 22, massPerMeter: 2, thickness: 0.08, stiffness: 0.95,
    tensionLimit: 0.08, compressionLimit: 0.0001,
    tensionOnly: true, sealing: false,
    minLength: 0.5, maxLength: 12,
  },
};

export const MATERIAL_ORDER = ['timber', 'steel', 'concrete', 'cable'];
