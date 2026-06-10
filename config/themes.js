const THEMES = {
  'mundial-argentina': {
    name: 'Mundial Argentina',
    description: 'Celebrá el fútbol con los colores albicelestes',
    preview: '🇦🇷',
    dateHint: 'Torneos / Copa del Mundo',
    defaultStart: '06-01',
    defaultEnd: '07-15',
    features: {
      confetti: {
        label: 'Papel picado',
        params: {
          confettiCount: { type: 'range', min: 5, max: 80, default: 30, label: 'Cantidad' },
          confettiSpeed: { type: 'select', options: ['slow','normal','fast'], labels: ['Lenta','Normal','Rápida'], default: 'normal', label: 'Velocidad' },
        },
      },
      buttonBorder: { label: 'Borde celeste en botones', params: {} },
      navColors:    { label: 'Colores Argentina en el nav', params: {} },
      flags:        { label: 'Banderitas flotantes', params: {} },
    },
  },

  'halloween': {
    name: 'Halloween',
    description: 'Terror y diversión para el 31 de octubre',
    preview: '🎃',
    dateHint: '31 de octubre',
    defaultStart: '10-24',
    defaultEnd: '10-31',
    features: {
      confetti: {
        label: 'Confeti de Halloween',
        params: {
          confettiCount: { type: 'range', min: 5, max: 80, default: 20, label: 'Cantidad' },
          confettiSpeed: { type: 'select', options: ['slow','normal','fast'], labels: ['Lenta','Normal','Rápida'], default: 'slow', label: 'Velocidad' },
        },
      },
      darkOverlay: { label: 'Fondo oscuro de Halloween', params: {} },
      spiders:     { label: 'Arañas decorativas', params: {} },
    },
  },

  'navidad': {
    name: 'Navidad',
    description: 'Magia navideña para fin de año',
    preview: '🎄',
    dateHint: '25 de diciembre',
    defaultStart: '12-18',
    defaultEnd: '01-06',
    features: {
      confetti: {
        label: 'Copos de nieve',
        params: {
          confettiCount: { type: 'range', min: 5, max: 60, default: 20, label: 'Cantidad de copos' },
          confettiSpeed: { type: 'select', options: ['slow','normal','fast'], labels: ['Lenta','Normal','Rápida'], default: 'slow', label: 'Velocidad' },
        },
      },
      navColors: { label: 'Colores navideños en el nav', params: {} },
      lights:    { label: 'Luces parpadeantes', params: {} },
    },
  },

  'dia-bandera': {
    name: 'Día de la Bandera',
    description: 'Homenaje al 20 de junio, creación de la bandera nacional',
    preview: '🏳️',
    dateHint: '20 de junio',
    defaultStart: '06-18',
    defaultEnd: '06-20',
    features: {
      confetti: {
        label: 'Papel picado celeste y blanco',
        params: {
          confettiCount: { type: 'range', min: 5, max: 80, default: 25, label: 'Cantidad' },
          confettiSpeed: { type: 'select', options: ['slow','normal','fast'], labels: ['Lenta','Normal','Rápida'], default: 'normal', label: 'Velocidad' },
        },
      },
      flags:     { label: 'Banderitas de la patria', params: {} },
      navColors: { label: 'Franja celeste y blanca en el nav', params: {} },
    },
  },

  'independencia': {
    name: 'Independencia Argentina',
    description: 'Celebración del 9 de julio, Día de la Independencia',
    preview: '🎆',
    dateHint: '9 de julio',
    defaultStart: '07-07',
    defaultEnd: '07-09',
    features: {
      confetti: {
        label: 'Fuegos artificiales de confeti',
        params: {
          confettiCount: { type: 'range', min: 5, max: 80, default: 40, label: 'Cantidad' },
          confettiSpeed: { type: 'select', options: ['slow','normal','fast'], labels: ['Lenta','Normal','Rápida'], default: 'fast', label: 'Velocidad' },
        },
      },
      flags:        { label: 'Banderas nacionales', params: {} },
      buttonBorder: { label: 'Borde patrio en botones', params: {} },
    },
  },

  'dia-maestro': {
    name: 'Día del Maestro',
    description: '11 de septiembre, homenaje a Domingo Faustino Sarmiento',
    preview: '📚',
    dateHint: '11 de septiembre',
    defaultStart: '09-09',
    defaultEnd: '09-11',
    features: {
      confetti: {
        label: 'Confeti festivo',
        params: {
          confettiCount: { type: 'range', min: 5, max: 60, default: 20, label: 'Cantidad' },
          confettiSpeed: { type: 'select', options: ['slow','normal','fast'], labels: ['Lenta','Normal','Rápida'], default: 'normal', label: 'Velocidad' },
        },
      },
      navColors: { label: 'Colores especiales en el nav', params: {} },
    },
  },

  'primavera': {
    name: 'Primavera',
    description: 'Día de la Primavera y del Estudiante, 21 de septiembre',
    preview: '🌸',
    dateHint: '21 de septiembre',
    defaultStart: '09-19',
    defaultEnd: '09-23',
    features: {
      confetti: {
        label: 'Pétalos de colores',
        params: {
          confettiCount: { type: 'range', min: 5, max: 80, default: 35, label: 'Cantidad de pétalos' },
          confettiSpeed: { type: 'select', options: ['slow','normal','fast'], labels: ['Lenta','Normal','Rápida'], default: 'slow', label: 'Velocidad' },
        },
      },
      navColors: { label: 'Colores primaverales en el nav', params: {} },
    },
  },

  'carnaval': {
    name: 'Carnaval',
    description: 'Fiesta y color para el carnaval argentino',
    preview: '🎭',
    dateHint: 'Febrero / Marzo',
    defaultStart: '02-10',
    defaultEnd: '02-28',
    features: {
      confetti: {
        label: 'Confeti multicolor',
        params: {
          confettiCount: { type: 'range', min: 5, max: 80, default: 50, label: 'Cantidad' },
          confettiSpeed: { type: 'select', options: ['slow','normal','fast'], labels: ['Lenta','Normal','Rápida'], default: 'fast', label: 'Velocidad' },
        },
      },
    },
  },
};

module.exports = THEMES;
