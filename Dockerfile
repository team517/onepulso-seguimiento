FROM nginx:alpine

# Copia el sitio estático
COPY index.html Plataforma.html Seguimiento.html /usr/share/nginx/html/
COPY assets/ /usr/share/nginx/html/assets/

# nginx sirve /usr/share/nginx/html en el puerto 80 por defecto
EXPOSE 80
